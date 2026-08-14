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
  TextComp,
} from "kaplay";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Sprite = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;
type MarkerSprite = GameObj<PosComp | TextComp | ColorComp | AnchorComp>;
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
  // "YOU" tag floating above the own snake's head for the first seconds —
  // both snakes start moving at once, so without it players can't tell
  // which one is theirs until it's too late.
  let youMarker: MarkerSprite | null = null;
  let youMarkerUntil = 0;

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

    // Pre-allocate one sprite per grid cell — running out silently drops
    // the newest cells (invisible snake segments) in long matches.
    const POOL_SIZE = cols * rows;
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = k.add([
        k.rect(cellW - 2, cellH - 2),
        k.pos(-99, -99),
        k.color(255, 255, 255),
        k.anchor("topleft"),
      ]);
      cellPool.push(s);
    }

    if (!ctx.isSpectator) {
      youMarker = k.add([
        k.text("▼ YOU", { size: 18 }),
        k.pos(-99, -99),
        k.color(255, 255, 255),
        k.anchor("bot"),
      ]);
    }

    // Swipe handling.
    if (!ctx.isSpectator) {
      const kk = k;
      const sendDisplayDir = (displayDir: Dir) => {
        // Convert display direction back to canonical (server frame).
        ctx.send({ type: "set-direction", dir: flipDir(displayDir) });
      };
      let touchStart: { x: number; y: number; t: number } | null = null;
      const beginSwipe = (pos: { x: number; y: number }) => {
        touchStart = { x: pos.x, y: pos.y, t: Date.now() };
      };
      const endSwipe = (pos: { x: number; y: number }) => {
        if (!touchStart) return;
        const dx = pos.x - touchStart.x;
        const dy = pos.y - touchStart.y;
        touchStart = null;
        if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) return;
        let displayDir: Dir;
        if (Math.abs(dx) > Math.abs(dy)) displayDir = dx > 0 ? "right" : "left";
        else displayDir = dy > 0 ? "down" : "up";
        sendDisplayDir(displayDir);
      };
      kk.onTouchStart(beginSwipe);
      kk.onTouchEnd(endSwipe);
      // Desktop fallback: mouse-drag swipes + arrow keys (previously a noop,
      // leaving desktop participants with no controls at all).
      kk.onMousePress(() => beginSwipe(kk.mousePos()));
      kk.onMouseRelease(() => endSwipe(kk.mousePos()));
      kk.onKeyPress("up", () => sendDisplayDir("up"));
      kk.onKeyPress("down", () => sendDisplayDir("down"));
      kk.onKeyPress("left", () => sendDisplayDir("left"));
      kk.onKeyPress("right", () => sendDisplayDir("right"));
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

    // Float the "YOU" tag above the own head while it's active.
    if (youMarker) {
      const head = myCells[0];
      if (role === "spectator" || !myAlive || !head || Date.now() > youMarkerUntil) {
        youMarker.hidden = true;
      } else {
        youMarker.hidden = false;
        youMarker.pos.x = flipX(head.x) * cellW + cellW / 2;
        youMarker.pos.y = Math.max(20, flipY(head.y) * cellH - 6);
      }
    }

    // Participants read "you – them"; spectators get canonical p1 – p2.
    const p1Len = msg.snakes.p1.cells.length;
    const p2Len = msg.snakes.p2.cells.length;
    ctx.setMatchScore(
      role === "p2" ? `${p2Len} – ${p1Len}` : `${p1Len} – ${p2Len}`,
    );
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    statusEl.textContent =
      role === "spectator"
        ? `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`
        : "swipe to turn";
    // Keep the tag visible through warm-up and the first seconds of play.
    youMarkerUntil = Date.now() + 7_000;
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
      youMarker = null;
      ctx.container.innerHTML = "";
    },
  };
}

const SnakeDuelClient: MiniGameClientDefinition = {
  id: "snake-duel",
  controlsHint: "swipe to steer — your snake starts at the bottom",
  createMatch: createSnakeDuelMatchClient,
};

registerMiniGameClient(SnakeDuelClient);

export default SnakeDuelClient;
