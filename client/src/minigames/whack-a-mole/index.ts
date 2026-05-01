// Whack-a-Mole client. 4×6 grid of cells; moles pop up briefly. Tap a
// mole to claim it. Live scoreboard at the top shows everyone's hit count.

import kaplay from "kaplay";
import type {
  AnchorComp,
  CircleComp,
  ColorComp,
  GameObj,
  PosComp,
} from "kaplay";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type MoleSprite = GameObj<PosComp | CircleComp | ColorComp | AnchorComp>;

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  grid: { cols: number; rows: number };
  durationMs: number;
  endsAt: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  moles: { id: number; col: number; row: number; despawnAt: number }[];
  scores: Record<string, number>;
  endsAt: number;
};

function createWhackAMoleMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="whack">
      <div class="whack-stage" id="whack-stage"></div>
      <div class="whack-status" id="whack-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#whack-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#whack-status")!;

  let fieldW = 500;
  let fieldH = 800;
  let cols = 4;
  let rows = 6;
  let cellW = fieldW / cols;
  let cellH = fieldH / rows;
  let endsAt = 0;
  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  // Per-mole sprite map.
  const moleSprites = new Map<number, MoleSprite>();

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    cols = welcome.grid.cols;
    rows = welcome.grid.rows;
    cellW = fieldW / cols;
    cellH = fieldH / rows;
    endsAt = welcome.endsAt;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [54, 36, 22],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });

    // Draw holes (dark brown circles).
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        k.add([
          k.circle(Math.min(cellW, cellH) * 0.38),
          k.pos(c * cellW + cellW / 2, r * cellH + cellH / 2),
          k.color(28, 18, 12),
          k.anchor("center"),
        ]);
      }
    }
  }

  function spawnMoleSprite(id: number, col: number, row: number) {
    if (!k) return;
    const sprite = k.add([
      k.circle(Math.min(cellW, cellH) * 0.34),
      k.pos(col * cellW + cellW / 2, row * cellH + cellH / 2),
      k.color(150, 90, 50),
      k.anchor("center"),
    ]);
    moleSprites.set(id, sprite);
  }

  function despawnMoleSprite(id: number) {
    const s = moleSprites.get(id);
    if (s) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    moleSprites.delete(id);
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    endsAt = msg.endsAt;

    // Sync mole sprites with server state.
    const wantIds = new Set(msg.moles.map((m) => m.id));
    for (const id of [...moleSprites.keys()]) {
      if (!wantIds.has(id)) despawnMoleSprite(id);
    }
    for (const m of msg.moles) {
      if (!moleSprites.has(m.id)) spawnMoleSprite(m.id, m.col, m.row);
    }

    // Update live scoreboard / status.
    const myScore = msg.scores[ctx.selfPlayerId] ?? 0;
    const total = Object.values(msg.scores).reduce((a, b) => a + b, 0);
    const remainingSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    statusEl.textContent = `${remainingSec}s · you ${myScore} / total ${total}`;
    ctx.setMatchScore(`${myScore} hits`);
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = "tap moles to score";
    buildScene(msg);
  }

  // Tap handler — translate to mole hit by checking which cell.
  let lastWhackAt = 0;
  const tap = (e: Event) => {
    if (ctx.isSpectator) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWhackAt < 50) return;
    lastWhackAt = now;
    if (!k) return;
    const pos = (e as TouchEvent).touches?.[0]
      ? (() => {
          const t = (e as TouchEvent).touches[0];
          const rect = stageEl.getBoundingClientRect();
          // Map screen coords to canvas coords (account for letterbox).
          const sx = (t.clientX - rect.left) / rect.width;
          const sy = (t.clientY - rect.top) / rect.height;
          return { x: sx * fieldW, y: sy * fieldH };
        })()
      : (() => {
          const m = (e as MouseEvent);
          const rect = stageEl.getBoundingClientRect();
          const sx = (m.clientX - rect.left) / rect.width;
          const sy = (m.clientY - rect.top) / rect.height;
          return { x: sx * fieldW, y: sy * fieldH };
        })();
    // Find the mole under the tap point (closest within radius).
    let best: { id: number; dist: number } | null = null;
    for (const [id, sprite] of moleSprites) {
      const dx = pos.x - sprite.pos.x;
      const dy = pos.y - sprite.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < Math.min(cellW, cellH) * 0.38 && (!best || dist < best.dist)) {
        best = { id, dist };
      }
    }
    if (best) {
      ctx.send({ type: "whack", moleId: best.id });
    }
  };
  stageEl.addEventListener("touchstart", tap, { passive: false });
  stageEl.addEventListener("mousedown", tap);

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
      moleSprites.clear();
      ctx.container.innerHTML = "";
    },
  };
}

const WhackAMoleClient: MiniGameClientDefinition = {
  id: "whack-a-mole",
  createMatch: createWhackAMoleMatchClient,
};

registerMiniGameClient(WhackAMoleClient);

export default WhackAMoleClient;
