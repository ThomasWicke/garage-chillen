// Memory Sequence client. DOM scene with a 2x2 grid of colored cells. The
// server flashes a sequence (cell index per state msg during "show"); the
// client highlights the indicated cell. During "input" the player taps
// cells to repeat. Wrong tap = eliminated. Live progress shown for self.

import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "show" | "input" | "result" | "ended";

type WelcomeMsg = {
  type: "welcome";
  gridSize: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  round: number;
  sequenceLength: number;
  showIdx: number;
  showCell: number | null;
  showStepEndsAt: number;
  inputDeadline: number;
  resultEndsAt: number;
  players: Record<
    string,
    { progress: number; eliminated: boolean; completedAt: number }
  >;
};

const COLOR_HEX = ["#e0524a", "#67c259", "#5a9bd4", "#e7c64a"];

function createMemorySequenceMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="ms">
      <div class="ms-banner" id="ms-banner">connecting…</div>
      <div class="ms-progress" id="ms-progress"></div>
      <div class="ms-grid" id="ms-grid"></div>
    </div>
  `;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#ms-banner")!;
  const progressEl = ctx.container.querySelector<HTMLElement>("#ms-progress")!;
  const gridEl = ctx.container.querySelector<HTMLElement>("#ms-grid")!;

  let lastTapAt = 0;
  let cellEls: HTMLButtonElement[] = [];

  function buildGrid(size: number) {
    gridEl.innerHTML = "";
    for (let i = 0; i < size; i++) {
      const btn = document.createElement("button");
      btn.className = "ms-cell";
      btn.style.background = COLOR_HEX[i % COLOR_HEX.length];
      btn.dataset.idx = String(i);
      const tap = (e: Event) => {
        if (ctx.isSpectator) return;
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        if (now - lastTapAt < 80) return;
        lastTapAt = now;
        ctx.send({ type: "tap-cell", index: i });
      };
      btn.addEventListener("touchstart", tap, { passive: false });
      btn.addEventListener("mousedown", tap);
      gridEl.appendChild(btn);
    }
    cellEls = Array.from(gridEl.querySelectorAll<HTMLButtonElement>(".ms-cell"));
  }

  function applyWelcome(msg: WelcomeMsg) {
    buildGrid(msg.gridSize);
    bannerEl.textContent = "watch the sequence";
  }

  function applyState(msg: StateMsg) {
    // Reset highlights, then highlight active flash if any.
    for (const c of cellEls) c.classList.remove("flash");
    if (msg.phase === "show" && msg.showCell !== null) {
      const c = cellEls[msg.showCell];
      if (c) c.classList.add("flash");
    }

    // Banner.
    if (msg.phase === "show") {
      bannerEl.textContent = `Round ${msg.round} · watch (${msg.sequenceLength})`;
    } else if (msg.phase === "input") {
      const me = msg.players[ctx.selfPlayerId];
      if (me?.eliminated) bannerEl.textContent = "eliminated · spectating";
      else if (me) bannerEl.textContent = `Round ${msg.round} · repeat ${me.progress}/${msg.sequenceLength}`;
      else bannerEl.textContent = "spectating";
    } else if (msg.phase === "result") {
      bannerEl.textContent = "round over";
    } else if (msg.phase === "ended") {
      bannerEl.textContent = "match over";
    }

    // Per-player progress for the live scoreboard.
    const aliveCount = Object.values(msg.players).filter((p) => !p.eliminated).length;
    const total = Object.keys(msg.players).length;
    ctx.setMatchScore(`${aliveCount}/${total} alive`);

    // Tiny progress dots row showing each alive player's progress.
    const dots = Object.entries(msg.players)
      .map(([pid, p]) => {
        if (p.eliminated) return `<span class="ms-dot dead"></span>`;
        const filled = "●".repeat(p.progress);
        const empty = "○".repeat(Math.max(0, msg.sequenceLength - p.progress));
        const cls = pid === ctx.selfPlayerId ? "ms-dot self" : "ms-dot";
        return `<span class="${cls}">${filled}${empty}</span>`;
      })
      .join("");
    progressEl.innerHTML = dots;

    // Disable cells when not in input phase OR self is eliminated.
    const me = msg.players[ctx.selfPlayerId];
    const interactive = msg.phase === "input" && me && !me.eliminated;
    for (const c of cellEls) c.classList.toggle("disabled", !interactive);
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

const MemorySequenceClient: MiniGameClientDefinition = {
  id: "memory-sequence",
  createMatch: createMemorySequenceMatchClient,
};

registerMiniGameClient(MemorySequenceClient);

export default MemorySequenceClient;
