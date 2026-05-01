// Snake Duel match client. Renders a portrait grid; the local player's
// snake is lime, opponent is sky-blue, food is pale red. Per-role view
// flip for p1 (their snake at the bottom of their phone). Inputs: swipe
// gestures translate to up/down/left/right.

import kaplay from "kaplay";
import type {
  AnchorComp,
  ColorComp,
  GameObj,
  PosComp,
  RectComp,
} from "kaplay";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Sprite = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;
type Role = "p1" | "p2" | "spectator";
type Dir = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  grid: { cols: number; rows: number };
  deadlineAt: number;
  players: {
    p1: { playerId: string; nickname: string; avatarId: string };
    p2: { playerId: string; nickname: string; avatarId: string };
  };
};

type StateMsg = {
  type: "state";
  step: number;
  snakes: {
    p1: { cells: Cell[]; alive: boolean; dir: Dir };
    p2: { cells: Cell[]; alive: boolean; dir: Dir };
  };
  food: Cell[];
};

const SWIPE_THRESHOLD = 22;

function createSnakeDuelMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="snake">
      <div class="snake-stage" id="snake-stage"></div>
      <div class="snake-status" id="snake-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#snake-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#snake-status")!;

  let role: Role = "spectator";
  let fieldW = 500;
  let fieldH = 800;
  let cols = 20;
  let rows = 32;
  let cellW = 25;
  let cellH = 25;
  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  // Pool of grid-cell sprites — one per max possible cell. We just
  // toggle visibility and color each frame.
  const cellPool: Sprite[] = [];

  // p1 view flip (180° vertical) so own snake is at bottom for p1.
  function flipY(y: number): number {
    return role === "p1" ? rows - 1 - y : y;
  }
  function flipX(x: number): number {
    return role === "p1" ? cols - 1 - x : x;
  }
  function flipDir(d: Dir): Dir {
    if (role !== "p1") return d;
    if (d === "up") return "down";
    if (d === "down") return "up";
    if (d === "left") return "right";
    return "left";
  }

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    cols = welcome.grid.cols;
    rows = welcome.grid.rows;
    cellW = fieldW / cols;
    cellH = fieldH / rows;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [10, 10, 20],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });

    // Grid lines (subtle).
    for (let i = 0; i <= cols; i++) {
      k.add([
        k.rect(1, fieldH),
        k.pos(i * cellW, 0),
        k.color(28, 28, 40),
      ]);
    }
    for (let j = 0; j <= rows; j++) {
      k.add([
        k.rect(fieldW, 1),
        k.pos(0, j * cellH),
        k.color(28, 28, 40),
      ]);
    }

    // Pre-allocate enough cells: snakes can grow to ~rows*cols, but in
    // practice ~150 is plenty. Round up to be safe.
    const POOL_SIZE = Math.min(cols * rows, 300);
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = k.add([
        k.rect(cellW - 2, cellH - 2),
        k.pos(-99, -99),
        k.color(255, 255, 255),
        k.anchor("topleft"),
      ]);
      cellPool.push(s);
    }

    // Swipe handling.
    if (!ctx.isSpectator) {
      let touchStart: { x: number; y: number; t: number } | null = null;
      k.onTouchStart((pos) => {
        touchStart = { x: pos.x, y: pos.y, t: Date.now() };
      });
      k.onTouchEnd((pos) => {
        if (!touchStart) return;
        const dx = pos.x - touchStart.x;
        const dy = pos.y - touchStart.y;
        if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
          touchStart = null;
          return;
        }
        let displayDir: Dir;
        if (Math.abs(dx) > Math.abs(dy)) displayDir = dx > 0 ? "right" : "left";
        else displayDir = dy > 0 ? "down" : "up";
        // Convert display direction back to canonical (server frame).
        const canonical = flipDir(displayDir);
        ctx.send({ type: "set-direction", dir: canonical });
        touchStart = null;
      });
      k.onMousePress(() => {
        // Desktop: noop — swipe via touch only.
      });
    }
  }

  function placeCell(idx: number, cx: number, cy: number, r: number, g: number, b: number) {
    const s = cellPool[idx];
    if (!s) return;
    s.pos.x = flipX(cx) * cellW + 1;
    s.pos.y = flipY(cy) * cellH + 1;
    s.color.r = r;
    s.color.g = g;
    s.color.b = b;
    s.hidden = false;
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    let i = 0;
    // Self snake is rendered slightly brighter.
    const myCells = role === "p2" ? msg.snakes.p2.cells : msg.snakes.p1.cells;
    const otherCells = role === "p2" ? msg.snakes.p1.cells : msg.snakes.p2.cells;

    // p1 = lime accent; p2 = sky blue. Keep canonical colors for
    // spectators — for participants, "self" is whichever they are.
    const p1Color = { r: 171, g: 221, b: 100 };
    const p2Color = { r: 100, g: 180, b: 240 };
    const myColor = role === "p2" ? p2Color : p1Color;
    const otherColor = role === "p2" ? p1Color : p2Color;

    // Tail dimming for both
    for (let j = 0; j < myCells.length; j++) {
      const c = myCells[j];
      const fade = j === 0 ? 1 : Math.max(0.6, 1 - j * 0.025);
      placeCell(
        i++,
        c.x,
        c.y,
        Math.floor(myColor.r * fade),
        Math.floor(myColor.g * fade),
        Math.floor(myColor.b * fade),
      );
    }
    for (let j = 0; j < otherCells.length; j++) {
      const c = otherCells[j];
      const fade = j === 0 ? 1 : Math.max(0.55, 1 - j * 0.025);
      placeCell(
        i++,
        c.x,
        c.y,
        Math.floor(otherColor.r * fade),
        Math.floor(otherColor.g * fade),
        Math.floor(otherColor.b * fade),
      );
    }
    for (const f of msg.food) {
      placeCell(i++, f.x, f.y, 235, 90, 90);
    }
    // Hide remaining cells.
    while (i < cellPool.length) {
      const s = cellPool[i++];
      s.hidden = true;
    }

    const myAlive = role === "p2" ? msg.snakes.p2.alive : msg.snakes.p1.alive;
    if (role === "spectator") {
      statusEl.textContent = "";
    } else {
      statusEl.textContent = myAlive ? "" : "you died";
    }
    ctx.setMatchScore(`${msg.snakes.p1.cells.length} – ${msg.snakes.p2.cells.length}`);
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    statusEl.textContent =
      role === "spectator"
        ? `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`
        : "swipe to turn";
    buildScene(msg);
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      try {
        k?.quit();
      } catch {
        /* ignore */
      }
      k = null;
      cellPool.length = 0;
      ctx.container.innerHTML = "";
    },
  };
}

const SnakeDuelClient: MiniGameClientDefinition = {
  id: "snake-duel",
  createMatch: createSnakeDuelMatchClient,
};

registerMiniGameClient(SnakeDuelClient);

export default SnakeDuelClient;
