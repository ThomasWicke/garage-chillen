// Light Cycles client. Renders the bike trails on a grid. p1 view is
// flipped 180° so own bike is at the bottom. Inputs: tap left half of
// screen to turn left, right half to turn right.

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
  bikes: {
    p1: { head: Cell; dir: Dir; alive: boolean; trail: Cell[] };
    p2: { head: Cell; dir: Dir; alive: boolean; trail: Cell[] };
  };
};

function createLightCyclesMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="cycles">
      <div class="cycles-stage" id="cycles-stage"></div>
      <div class="cycles-status" id="cycles-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#cycles-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#cycles-status")!;

  let role: Role = "spectator";
  let fieldW = 500;
  let fieldH = 800;
  let cols = 20;
  let rows = 32;
  let cellW = 25;
  let cellH = 25;
  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  const cellPool: Sprite[] = [];

  function flipY(y: number): number {
    return role === "p1" ? rows - 1 - y : y;
  }
  function flipX(x: number): number {
    return role === "p1" ? cols - 1 - x : x;
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
      background: [6, 6, 16],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });

    // Fine grid.
    for (let i = 0; i <= cols; i++) {
      k.add([k.rect(1, fieldH), k.pos(i * cellW, 0), k.color(22, 22, 36)]);
    }
    for (let j = 0; j <= rows; j++) {
      k.add([k.rect(fieldW, 1), k.pos(0, j * cellH), k.color(22, 22, 36)]);
    }

    // Pool — long matches can fill many cells. Cap at half the grid.
    const POOL = Math.min(cols * rows, 600);
    for (let i = 0; i < POOL; i++) {
      const s = k.add([
        k.rect(cellW - 1, cellH - 1),
        k.pos(-99, -99),
        k.color(255, 255, 255),
        k.anchor("topleft"),
      ]);
      cellPool.push(s);
    }

    if (!ctx.isSpectator) {
      // Tap left half = turn left, right half = turn right. The "left/right"
      // is in DISPLAY space — we need to convert to canonical for p1
      // (whose view is 180° flipped).
      k.onTouchStart((pos) => {
        const displaySide: "left" | "right" = pos.x < fieldW / 2 ? "left" : "right";
        const canonicalSide =
          role === "p1"
            ? displaySide === "left"
              ? "right"
              : "left"
            : displaySide;
        ctx.send({ type: "turn", side: canonicalSide });
      });
      k.onMousePress(() => {
        if (!k) return;
        const m = k.mousePos();
        const displaySide: "left" | "right" = m.x < fieldW / 2 ? "left" : "right";
        const canonicalSide =
          role === "p1"
            ? displaySide === "left"
              ? "right"
              : "left"
            : displaySide;
        ctx.send({ type: "turn", side: canonicalSide });
      });
    }
  }

  function placeCell(idx: number, cx: number, cy: number, r: number, g: number, b: number) {
    const s = cellPool[idx];
    if (!s) return;
    s.pos.x = flipX(cx) * cellW + 0.5;
    s.pos.y = flipY(cy) * cellH + 0.5;
    s.color.r = r;
    s.color.g = g;
    s.color.b = b;
    s.hidden = false;
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    let i = 0;
    const p1Color = { r: 171, g: 221, b: 100 };
    const p2Color = { r: 100, g: 180, b: 240 };
    const myCells = role === "p2" ? msg.bikes.p2.trail : msg.bikes.p1.trail;
    const otherCells = role === "p2" ? msg.bikes.p1.trail : msg.bikes.p2.trail;
    const myColor = role === "p2" ? p2Color : p1Color;
    const otherColor = role === "p2" ? p1Color : p2Color;
    const myHead = role === "p2" ? msg.bikes.p2.head : msg.bikes.p1.head;
    const otherHead = role === "p2" ? msg.bikes.p1.head : msg.bikes.p2.head;

    for (const c of myCells) {
      const isHead = c.x === myHead.x && c.y === myHead.y;
      placeCell(
        i++,
        c.x,
        c.y,
        isHead ? 255 : myColor.r,
        isHead ? 255 : myColor.g,
        isHead ? 255 : myColor.b,
      );
    }
    for (const c of otherCells) {
      const isHead = c.x === otherHead.x && c.y === otherHead.y;
      placeCell(
        i++,
        c.x,
        c.y,
        isHead ? 255 : otherColor.r,
        isHead ? 255 : otherColor.g,
        isHead ? 255 : otherColor.b,
      );
    }
    while (i < cellPool.length) {
      const s = cellPool[i++];
      s.hidden = true;
    }

    if (role !== "spectator") {
      const myAlive = role === "p2" ? msg.bikes.p2.alive : msg.bikes.p1.alive;
      statusEl.textContent = myAlive ? "" : "you crashed";
    } else {
      statusEl.textContent = "";
    }
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    statusEl.textContent =
      role === "spectator"
        ? `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`
        : "tap left/right to turn";
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

const LightCyclesClient: MiniGameClientDefinition = {
  id: "light-cycles",
  createMatch: createLightCyclesMatchClient,
};

registerMiniGameClient(LightCyclesClient);

export default LightCyclesClient;
