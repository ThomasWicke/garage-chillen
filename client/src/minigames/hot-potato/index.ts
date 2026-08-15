// Hot Potato client. DOM-based scene. Shows all players' avatars in a
// grid; the current holder is enlarged and lit up with a 🥔 indicator. If
// you ARE the holder, a giant tap-to-pass button covers the screen.

import { avatarSrc } from "../../identity";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "live" | "elim-pause" | "ended";

type WelcomeMsg = {
  type: "welcome";
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  holderId: string | null;
  alive: string[];
  lastEliminated: { playerId: string; nickname: string } | null;
  pauseUntil: number;
  /** Server time when the current holder may pass (pass-arm delay). */
  armAt: number;
  deadlineAt?: number;
};

function createHotPotatoMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="hp">
      <div class="hp-banner" id="hp-banner"></div>
      <div class="hp-grid" id="hp-grid"></div>
      <button class="hp-pass-btn" id="hp-pass-btn" type="button" hidden>PASS</button>
    </div>
  `;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#hp-banner")!;
  const gridEl = ctx.container.querySelector<HTMLElement>("#hp-grid")!;
  const passBtn = ctx.container.querySelector<HTMLButtonElement>("#hp-pass-btn")!;

  let players: WelcomeMsg["players"] = [];

  // Tap handler for the pass button.
  let lastTapAt = 0;
  const tap = (e: Event) => {
    if (ctx.isSpectator) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapAt < 80) return;
    lastTapAt = now;
    ctx.send({ type: "pass-potato" });
  };
  passBtn.addEventListener("touchstart", tap, { passive: false });
  passBtn.addEventListener("mousedown", tap);

  // Grid is built ONCE from the welcome roster; per-state updates only
  // toggle classes. Rebuilding innerHTML (with <img>s) at 30Hz flickered
  // avatars and killed the holder-highlight CSS transition.
  const cellByPlayerId = new Map<string, HTMLElement>();

  function buildGrid() {
    gridEl.innerHTML = players
      .map(
        (p) => `<div class="hp-cell" data-pid="${escapeHtml(p.playerId)}">
          <div class="hp-avatar"><img src="${avatarSrc(p.avatarId)}" alt="" /></div>
          <div class="hp-nick">${escapeHtml(p.nickname)}</div>
          <div class="hp-potato" hidden>🥔</div>
        </div>`,
      )
      .join("");
    cellByPlayerId.clear();
    gridEl.querySelectorAll<HTMLElement>(".hp-cell").forEach((el) => {
      cellByPlayerId.set(el.dataset.pid!, el);
    });
  }

  function updateGrid(state: StateMsg) {
    const aliveSet = new Set(state.alive);
    for (const p of players) {
      const cell = cellByPlayerId.get(p.playerId);
      if (!cell) continue;
      const isHolder = state.holderId === p.playerId;
      cell.classList.toggle("dead", !aliveSet.has(p.playerId));
      cell.classList.toggle("holder", isHolder);
      cell.classList.toggle("self", p.playerId === ctx.selfPlayerId);
      const potato = cell.querySelector<HTMLElement>(".hp-potato");
      if (potato) potato.hidden = !isHolder;
    }
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    buildGrid();
    bannerEl.textContent = "watch the potato…";
  }

  function applyState(msg: StateMsg) {
    updateGrid(msg);

    const alive = msg.alive.length;
    const total = players.length;
    // Deliberately NO clock: in a potato game a visible countdown reads as
    // the fuse. The deadline is a generous safety cap (180s), not a fuse.
    ctx.setMatchScore(`${alive}/${total} alive`);

    const iAmAlive = msg.alive.includes(ctx.selfPlayerId);
    const iAmHolder = msg.holderId === ctx.selfPlayerId;

    if (msg.phase === "elim-pause" && msg.lastEliminated) {
      bannerEl.textContent = `💥 ${msg.lastEliminated.nickname} got burned`;
    } else if (msg.phase === "live") {
      if (!iAmAlive) bannerEl.textContent = "spectating";
      else if (iAmHolder) bannerEl.textContent = "🔥 TAP TO PASS";
      else bannerEl.textContent = "stay cool…";
    } else {
      bannerEl.textContent = "";
    }

    // Show pass button only if I'm the live holder. While the pass-arm
    // delay runs, the button is visibly disarmed (server rejects taps).
    passBtn.hidden = !(msg.phase === "live" && iAmHolder && !ctx.isSpectator);
    if (!passBtn.hidden) {
      const armed = Date.now() >= msg.armAt;
      passBtn.disabled = !armed;
      passBtn.textContent = armed ? "PASS" : "…";
    }
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      ctx.container.innerHTML = "";
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const HotPotatoClient: MiniGameClientDefinition = {
  id: "hot-potato",
  controlsHint: "got the potato? tap to pass it before it pops!",
  createMatch: createHotPotatoMatchClient,
};

registerMiniGameClient(HotPotatoClient);

export default HotPotatoClient;
