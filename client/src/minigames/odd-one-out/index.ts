// Odd One Out client. DOM-based: a CSS grid of colored tile buttons, one
// tile a slightly different shade. Tap the odd one first for +3; a wrong
// tap greys your board out for the round. Reveal pulses the odd tile.

import { avatarSrc } from "../../identity";
import { registerMiniGameClient } from "../registry";
import { statusLine } from "../clock";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "play" | "reveal" | "ended";

type Hsl = { h: number; s: number; l: number };

type WelcomeMsg = {
  type: "welcome";
  rounds: number;
  roundMs: number;
  revealMs: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  round: number;
  rounds: number;
  gridSize: number;
  baseColor: Hsl;
  oddColor: Hsl;
  oddIndex: number;
  lockedOut: string[];
  roundWinner: string | null;
  phaseEndsAt: number;
  scores: Record<string, number>;
  deadlineAt: number;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function hsl(c: Hsl): string {
  return `hsl(${c.h}, ${c.s}%, ${c.l}%)`;
}

function createOddOneOutMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .ooo { display: flex; flex-direction: column; height: 100%; padding: 12px;
        box-sizing: border-box; background: #0a0a14; color: #f2f2f5;
        font-family: system-ui, sans-serif; gap: 10px; }
      .ooo-status { text-align: center; font-size: 14px; color: #9a9aa5; min-height: 18px; }
      .ooo-banner { text-align: center; font-size: 17px; font-weight: 600;
        min-height: 24px; color: #abdd64; }
      .ooo-grid { display: grid; gap: 6px; width: 100%; max-width: 440px;
        margin: 0 auto; transition: opacity 150ms, filter 150ms; }
      .ooo-grid.ooo-locked { opacity: 0.35; filter: grayscale(0.8); }
      .ooo-tile { aspect-ratio: 1; width: 100%; border: none; border-radius: 10px;
        padding: 0; touch-action: manipulation;
        -webkit-tap-highlight-color: transparent; }
      .ooo-tile.ooo-pulse { animation: ooo-pulse 400ms ease-in-out infinite alternate;
        outline: 3px solid #f2f2f5; z-index: 1; }
      @keyframes ooo-pulse { from { transform: scale(1); } to { transform: scale(1.14); } }
      .ooo-board { flex: 1; overflow-y: auto; display: flex; flex-direction: column;
        gap: 4px; margin-top: 4px; }
      .ooo-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
        border-radius: 10px; background: #12121f; }
      .ooo-row.ooo-self { outline: 1px solid #abdd64; }
      .ooo-row img { width: 28px; height: 28px; border-radius: 50%; }
      .ooo-row .ooo-nick { flex: 1; font-size: 14px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .ooo-row .ooo-pts { font-size: 15px; font-weight: 700; }
      .ooo-row.ooo-won { animation: ooo-won 900ms; }
      @keyframes ooo-won { 0% { background: #2c5d2c; } 100% { background: #12121f; } }
    </style>
    <div class="ooo">
      <div class="ooo-status" id="ooo-status"></div>
      <div class="ooo-banner" id="ooo-banner"></div>
      <div class="ooo-grid" id="ooo-grid"></div>
      <div class="ooo-board" id="ooo-board"></div>
    </div>
  `;
  const statusEl = ctx.container.querySelector<HTMLElement>("#ooo-status")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#ooo-banner")!;
  const gridEl = ctx.container.querySelector<HTMLElement>("#ooo-grid")!;
  const boardEl = ctx.container.querySelector<HTMLElement>("#ooo-board")!;

  let players: WelcomeMsg["players"] = [];
  let totalRounds = 10;
  let built = false;
  let amPlayer = false;

  let shownBoardKey = "";
  let lastTapAt = 0;
  const tiles: HTMLButtonElement[] = [];
  const rowByPlayerId = new Map<string, HTMLElement>();

  function applyWelcome(msg: WelcomeMsg) {
    if (built) return; // welcome is replayed on reconnect — build once
    built = true;
    players = msg.players;
    totalRounds = msg.rounds;
    amPlayer =
      !ctx.isSpectator && players.some((p) => p.playerId === ctx.selfPlayerId);
    // Scoreboard rows built ONCE (avatar <img> flickers if rebuilt at 30Hz);
    // ranking is applied via flex `order`.
    boardEl.innerHTML = players
      .map(
        (p) => `<div class="ooo-row${p.playerId === ctx.selfPlayerId ? " ooo-self" : ""}" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <span class="ooo-nick">${escapeHtml(p.nickname)}${p.playerId === ctx.selfPlayerId ? " (you)" : ""}</span>
          <span class="ooo-pts">0</span>
        </div>`,
      )
      .join("");
    rowByPlayerId.clear();
    boardEl.querySelectorAll<HTMLElement>(".ooo-row").forEach((el) => {
      rowByPlayerId.set(el.dataset.pid!, el);
    });
    bannerEl.textContent = "find the odd tile…";
  }

  function buildGrid(msg: StateMsg) {
    gridEl.style.gridTemplateColumns = `repeat(${msg.gridSize}, 1fr)`;
    gridEl.innerHTML = "";
    tiles.length = 0;
    const cells = msg.gridSize * msg.gridSize;
    for (let i = 0; i < cells; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ooo-tile";
      b.style.background = hsl(i === msg.oddIndex ? msg.oddColor : msg.baseColor);
      const idx = i;
      const tap = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!amPlayer) return;
        const now = Date.now();
        if (now - lastTapAt < 80) return;
        lastTapAt = now;
        ctx.send({ type: "tap", index: idx });
      };
      b.addEventListener("touchstart", tap, { passive: false });
      b.addEventListener("mousedown", tap);
      gridEl.appendChild(b);
      tiles.push(b);
    }
  }

  function updateBoard(scores: Record<string, number>, roundWinner: string | null) {
    const sorted = [...players].sort(
      (a, b) => (scores[b.playerId] ?? 0) - (scores[a.playerId] ?? 0),
    );
    sorted.forEach((p, i) => {
      const row = rowByPlayerId.get(p.playerId);
      if (!row) return;
      row.style.order = String(i);
      row.querySelector<HTMLElement>(".ooo-pts")!.textContent = String(scores[p.playerId] ?? 0);
      row.classList.toggle("ooo-won", p.playerId === roundWinner);
    });
  }

  function applyState(msg: StateMsg) {
    if (!built) return; // welcome is cached+replayed; states resume right after
    // New round (or reconnect): rebuild the tile grid.
    const boardKey = `${msg.round}:${msg.gridSize}:${msg.oddIndex}:${msg.baseColor.h},${msg.baseColor.l}`;
    if (boardKey !== shownBoardKey) {
      shownBoardKey = boardKey;
      buildGrid(msg);
    }

    const iAmLocked = msg.lockedOut.includes(ctx.selfPlayerId);
    gridEl.classList.toggle("ooo-locked", msg.phase === "play" && iAmLocked);
    tiles.forEach((t, i) => {
      t.disabled = !amPlayer || msg.phase !== "play" || iAmLocked;
      t.classList.toggle("ooo-pulse", msg.phase === "reveal" && i === msg.oddIndex);
    });

    const secs = Math.max(0, Math.ceil((msg.phaseEndsAt - Date.now()) / 1000));
    statusEl.textContent = statusLine(
      `round ${msg.round}/${msg.rounds ?? totalRounds}`,
      msg.phase === "play" ? `${secs}s` : null,
      // No total clock — rounds end on the first correct tap.
    );

    if (msg.phase === "play") {
      if (!amPlayer) bannerEl.textContent = "spectating";
      else if (iAmLocked) bannerEl.textContent = "wrong tile — locked out";
      else bannerEl.textContent = "GO!";
    } else if (msg.phase === "reveal") {
      const nick = msg.roundWinner
        ? players.find((p) => p.playerId === msg.roundWinner)?.nickname
        : null;
      bannerEl.textContent = nick ? `👁 ${nick} found it +3` : "nobody found it!";
    } else {
      bannerEl.textContent = "final scores";
    }

    updateBoard(msg.scores, msg.phase === "reveal" ? msg.roundWinner : null);

    const myPts = msg.scores[ctx.selfPlayerId];
    const top = Math.max(0, ...Object.values(msg.scores));
    ctx.setMatchScore(amPlayer ? `${myPts ?? 0} pts` : `top ${top} pts`);
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

const OddOneOutClient: MiniGameClientDefinition = {
  id: "odd-one-out",
  controlsHint: "one tile is a different shade — tap it first! wrong tap = locked out",
  createMatch: createOddOneOutMatchClient,
};

registerMiniGameClient(OddOneOutClient);

export default OddOneOutClient;
