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

  function renderGrid(state: StateMsg) {
    const aliveSet = new Set(state.alive);
    gridEl.innerHTML = players
      .map((p) => {
        const isAlive = aliveSet.has(p.playerId);
        const isHolder = state.holderId === p.playerId;
        const cls = [
          "hp-cell",
          isAlive ? "" : "dead",
          isHolder ? "holder" : "",
          p.playerId === ctx.selfPlayerId ? "self" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<div class="${cls}">
          <div class="hp-avatar"><img src="${avatarSrc(p.avatarId)}" alt="" /></div>
          <div class="hp-nick">${escapeHtml(p.nickname)}</div>
          ${isHolder ? `<div class="hp-potato">🥔</div>` : ""}
        </div>`;
      })
      .join("");
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    bannerEl.textContent = "watch the potato…";
  }

  function applyState(msg: StateMsg) {
    renderGrid(msg);

    const alive = msg.alive.length;
    const total = players.length;
    ctx.setMatchScore(`${alive}/${total} alive`);

    const iAmAlive = msg.alive.includes(ctx.selfPlayerId);
    const iAmHolder = msg.holderId === ctx.selfPlayerId;

    if (msg.phase === "elim-pause" && msg.lastEliminated) {
      bannerEl.textContent = `💥 ${msg.lastEliminated.nickname} got burned`;
    } else if (msg.phase === "live") {
      if (!iAmAlive) bannerEl.textContent = "spectating · keep watching";
      else if (iAmHolder) bannerEl.textContent = "🔥 you have it · TAP TO PASS";
      else bannerEl.textContent = "stay cool…";
    } else {
      bannerEl.textContent = "";
    }

    // Show pass button only if I'm the live holder.
    passBtn.hidden = !(msg.phase === "live" && iAmHolder && !ctx.isSpectator);
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
  createMatch: createHotPotatoMatchClient,
};

registerMiniGameClient(HotPotatoClient);

export default HotPotatoClient;
