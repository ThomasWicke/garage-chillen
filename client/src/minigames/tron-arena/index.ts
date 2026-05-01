// Tron Arena client. Renders many bikes' trails on a portrait grid. Each
// player has a color derived from their playerId. Self trail is brighter.
// Inputs: tap left half of screen to turn left, right half to turn right.

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
type Dir = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  grid: { cols: number; rows: number };
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  step: number;
  bikes: Record<
    string,
    { head: Cell; dir: Dir; alive: boolean; trail: Cell[] }
  >;
};

// Build a stable color per playerId by hashing.
function colorFor(playerId: string): { r: number; g: number; b: number } {
  let h = 5381;
  for (let i = 0; i < playerId.length; i++) {
    h = ((h << 5) + h + playerId.charCodeAt(i)) | 0;
  }
  // Generate from hue.
  const hue = ((h >>> 0) % 360) / 360;
  const s = 0.7;
  const l = 0.55;
  return hslToRgb(hue, s, l);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function createTronArenaMatchClient(
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

  let fieldW = 500;
  let fieldH = 800;
  let cols = 22;
  let rows = 36;
  let cellW = fieldW / cols;
  let cellH = fieldH / rows;
  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  const cellPool: Sprite[] = [];

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

    for (let i = 0; i <= cols; i++) {
      k.add([k.rect(1, fieldH), k.pos(i * cellW, 0), k.color(22, 22, 36)]);
    }
    for (let j = 0; j <= rows; j++) {
      k.add([k.rect(fieldW, 1), k.pos(0, j * cellH), k.color(22, 22, 36)]);
    }

    const POOL = Math.min(cols * rows, 700);
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
      k.onTouchStart((pos) => {
        const side: "left" | "right" = pos.x < fieldW / 2 ? "left" : "right";
        ctx.send({ type: "turn", side });
      });
      k.onMousePress(() => {
        if (!k) return;
        const m = k.mousePos();
        const side: "left" | "right" = m.x < fieldW / 2 ? "left" : "right";
        ctx.send({ type: "turn", side });
      });
    }
  }

  function placeCell(idx: number, cx: number, cy: number, r: number, g: number, b: number) {
    const s = cellPool[idx];
    if (!s) return;
    s.pos.x = cx * cellW + 0.5;
    s.pos.y = cy * cellH + 0.5;
    s.color.r = r;
    s.color.g = g;
    s.color.b = b;
    s.hidden = false;
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    let i = 0;

    // Render order: others first, self LAST so own trail is on top.
    const entries = Object.entries(msg.bikes);
    entries.sort((a, b) => {
      if (a[0] === ctx.selfPlayerId) return 1;
      if (b[0] === ctx.selfPlayerId) return -1;
      return 0;
    });

    for (const [pid, bike] of entries) {
      const isSelf = pid === ctx.selfPlayerId;
      const c = colorFor(pid);
      // Dead bikes fade out a bit.
      const fade = bike.alive ? 1 : 0.45;
      const r = Math.floor(c.r * fade);
      const g = Math.floor(c.g * fade);
      const b = Math.floor(c.b * fade);
      for (const cell of bike.trail) {
        const isHead = cell.x === bike.head.x && cell.y === bike.head.y;
        if (isHead && bike.alive) {
          placeCell(i++, cell.x, cell.y, 255, 255, 255);
        } else {
          // Self gets a slight saturation boost.
          if (isSelf) {
            placeCell(
              i++,
              cell.x,
              cell.y,
              Math.min(255, r + 20),
              Math.min(255, g + 20),
              Math.min(255, b + 20),
            );
          } else {
            placeCell(i++, cell.x, cell.y, r, g, b);
          }
        }
      }
    }
    while (i < cellPool.length) {
      const s = cellPool[i++];
      s.hidden = true;
    }

    const me = msg.bikes[ctx.selfPlayerId];
    if (me) {
      statusEl.textContent = me.alive ? "" : "you crashed · keep watching";
    } else {
      statusEl.textContent = "spectating";
    }
    const aliveCount = Object.values(msg.bikes).filter((b) => b.alive).length;
    const total = Object.keys(msg.bikes).length;
    ctx.setMatchScore(`${aliveCount}/${total} alive`);
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = ctx.isSpectator
      ? "spectating"
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

const TronArenaClient: MiniGameClientDefinition = {
  id: "tron-arena",
  createMatch: createTronArenaMatchClient,
};

registerMiniGameClient(TronArenaClient);

export default TronArenaClient;
