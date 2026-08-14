// Quick Math client. DOM-based: giant problem text, 2x2 answer grid, live
// scoreboard. First tap locks your answer; reveal colors the grid green/red
// and shows who scored. The correct index only arrives with the reveal
// broadcast, so there is nothing to peek at during the question phase.

import { avatarSrc } from "../../identity";
import { registerMiniGameClient } from "../registry";
import { formatRemaining, statusLine } from "../clock";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "question" | "reveal" | "ended";

type WelcomeMsg = {
  type: "welcome";
  rounds: number;
  questionMs: number;
  revealMs: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  /** false during warm-up — buttons stay disarmed until GO. */
  live: boolean;
  phase: Phase;
  round: number;
  rounds: number;
  problem: string;
  choices: number[];
  answeredIds: string[];
  phaseEndsAt: number;
  scores: Record<string, number>;
  deadlineAt: number;
  // reveal-only:
  correctIndex?: number;
  picks?: Record<string, number>;
  roundPoints?: Record<string, number>;
  firstCorrectId?: string | null;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function createQuickMathMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .qm { display: flex; flex-direction: column; height: 100%; padding: 12px;
        box-sizing: border-box; background: #0a0a14; color: #f2f2f5;
        font-family: system-ui, sans-serif; gap: 10px; }
      .qm-status { text-align: center; font-size: 14px; color: #9a9aa5; min-height: 18px; }
      .qm-problem { text-align: center; font-size: clamp(40px, 13vw, 72px);
        font-weight: 800; letter-spacing: 1px; min-height: 1.2em; line-height: 1.2; }
      .qm-banner { text-align: center; font-size: 16px; min-height: 22px; color: #abdd64; }
      .qm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .qm-btn { min-height: 84px; font-size: 34px; font-weight: 700;
        border-radius: 14px; border: 2px solid #2a2a3c; background: #16162a;
        color: #f2f2f5; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
        transition: transform 80ms, background 120ms, border-color 120ms; }
      .qm-btn:disabled { opacity: 0.85; }
      .qm-btn.qm-mine { border-color: #abdd64; background: #22301a; }
      .qm-btn.qm-good { background: #2c5d2c; border-color: #57c957; animation: qm-pop 300ms; }
      .qm-btn.qm-bad { background: #5d2c2c; border-color: #c95757; animation: qm-shake 300ms; }
      .qm-btn.qm-dim { opacity: 0.4; }
      @keyframes qm-pop { 50% { transform: scale(1.06); } }
      @keyframes qm-shake { 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
      .qm-board { flex: 1; overflow-y: auto; display: flex; flex-direction: column;
        gap: 4px; margin-top: 4px; }
      .qm-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
        border-radius: 10px; background: #12121f; }
      .qm-row.qm-self { outline: 1px solid #abdd64; }
      .qm-row img { width: 28px; height: 28px; border-radius: 50%; }
      .qm-row .qm-nick { flex: 1; font-size: 14px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .qm-row .qm-pts { font-size: 15px; font-weight: 700; }
      .qm-row .qm-delta { font-size: 13px; font-weight: 700; color: #abdd64;
        min-width: 26px; text-align: right; }
      .qm-row.qm-scored .qm-delta { animation: qm-flash 900ms; }
      @keyframes qm-flash { 0% { transform: scale(1.5); } 100% { transform: scale(1); } }
    </style>
    <div class="qm">
      <div class="qm-status" id="qm-status"></div>
      <div class="qm-problem" id="qm-problem"></div>
      <div class="qm-banner" id="qm-banner"></div>
      <div class="qm-grid" id="qm-grid"></div>
      <div class="qm-board" id="qm-board"></div>
    </div>
  `;
  const statusEl = ctx.container.querySelector<HTMLElement>("#qm-status")!;
  const problemEl = ctx.container.querySelector<HTMLElement>("#qm-problem")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#qm-banner")!;
  const gridEl = ctx.container.querySelector<HTMLElement>("#qm-grid")!;
  const boardEl = ctx.container.querySelector<HTMLElement>("#qm-board")!;

  let players: WelcomeMsg["players"] = [];
  let totalRounds = 8;
  let built = false;
  let amPlayer = false;

  // Per-round local state.
  let shownRound = -1;
  let shownChoices = "";
  let live = false;
  let myPick: number | null = null;
  let lastTapAt = 0;
  const btns: HTMLButtonElement[] = [];
  const rowByPlayerId = new Map<string, HTMLElement>();

  function applyWelcome(msg: WelcomeMsg) {
    if (built) return; // welcome is replayed on reconnect — build once
    built = true;
    players = msg.players;
    totalRounds = msg.rounds;
    amPlayer =
      !ctx.isSpectator && players.some((p) => p.playerId === ctx.selfPlayerId);
    // Scoreboard rows are built ONCE (avatar <img> flickers if rebuilt at
    // 30Hz); ranking is applied via flex `order`.
    boardEl.innerHTML = players
      .map(
        (p) => `<div class="qm-row${p.playerId === ctx.selfPlayerId ? " qm-self" : ""}" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <span class="qm-nick">${escapeHtml(p.nickname)}${p.playerId === ctx.selfPlayerId ? " (you)" : ""}</span>
          <span class="qm-delta"></span>
          <span class="qm-pts">0</span>
        </div>`,
      )
      .join("");
    rowByPlayerId.clear();
    boardEl.querySelectorAll<HTMLElement>(".qm-row").forEach((el) => {
      rowByPlayerId.set(el.dataset.pid!, el);
    });
    bannerEl.textContent = "get ready…";
  }

  function buildButtons(choices: number[]) {
    gridEl.innerHTML = "";
    btns.length = 0;
    choices.forEach((val, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "qm-btn";
      b.textContent = String(val);
      const tap = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!amPlayer || !live) return; // warm-up taps must not lock myPick
        const now = Date.now();
        if (now - lastTapAt < 80) return;
        lastTapAt = now;
        if (myPick !== null) return;
        myPick = idx;
        ctx.send({ type: "answer", choice: idx });
        renderLock();
      };
      b.addEventListener("touchstart", tap, { passive: false });
      b.addEventListener("mousedown", tap);
      gridEl.appendChild(b);
      btns.push(b);
    });
  }

  function renderLock() {
    btns.forEach((b, idx) => {
      b.disabled = myPick !== null || !amPlayer;
      b.classList.toggle("qm-mine", myPick === idx);
    });
  }

  function updateBoard(scores: Record<string, number>, roundPoints?: Record<string, number>) {
    const sorted = [...players].sort(
      (a, b) => (scores[b.playerId] ?? 0) - (scores[a.playerId] ?? 0),
    );
    sorted.forEach((p, i) => {
      const row = rowByPlayerId.get(p.playerId);
      if (!row) return;
      row.style.order = String(i);
      row.querySelector<HTMLElement>(".qm-pts")!.textContent = String(scores[p.playerId] ?? 0);
      const delta = roundPoints?.[p.playerId];
      const deltaEl = row.querySelector<HTMLElement>(".qm-delta")!;
      deltaEl.textContent = delta ? `+${delta}` : "";
      row.classList.toggle("qm-scored", !!delta);
    });
  }

  function applyState(msg: StateMsg) {
    if (!built) return; // welcome is cached+replayed; states resume right after
    live = msg.live === true;
    // New round (or reconnect mid-round): rebuild the answer grid.
    const choicesKey = `${msg.round}:${msg.choices.join(",")}`;
    if (msg.round !== shownRound || choicesKey !== shownChoices) {
      shownRound = msg.round;
      shownChoices = choicesKey;
      myPick = null;
      buildButtons(msg.choices);
      renderLock();
    }
    problemEl.textContent = `${msg.problem} = ?`;

    // Reconnect resync: server says I already answered but I lost the pick.
    if (
      msg.phase === "question" &&
      myPick === null &&
      msg.answeredIds.includes(ctx.selfPlayerId)
    ) {
      btns.forEach((b) => (b.disabled = true));
    }

    const secs = Math.max(0, Math.ceil((msg.phaseEndsAt - Date.now()) / 1000));
    statusEl.textContent = statusLine(
      `round ${msg.round}/${msg.rounds ?? totalRounds}`,
      msg.phase === "question" ? `${secs}s` : null,
      formatRemaining(msg.deadlineAt),
    );

    if (msg.phase === "question") {
      btns.forEach((b) => b.classList.remove("qm-good", "qm-bad", "qm-dim"));
      if (!amPlayer) {
        bannerEl.textContent = "spectating";
        btns.forEach((b) => (b.disabled = true));
      } else if (!live) {
        bannerEl.textContent = "get ready…";
        btns.forEach((b) => (b.disabled = true));
      } else if (myPick !== null || msg.answeredIds.includes(ctx.selfPlayerId)) {
        bannerEl.textContent = "locked in — waiting…";
      } else {
        bannerEl.textContent = "tap the answer!";
        renderLock(); // re-arm buttons once GO flips live on
      }
      updateBoard(msg.scores);
    } else if (msg.phase === "reveal") {
      const correct = msg.correctIndex ?? -1;
      const selfPick = msg.picks?.[ctx.selfPlayerId];
      btns.forEach((b, idx) => {
        b.disabled = true;
        b.classList.toggle("qm-good", idx === correct);
        b.classList.toggle(
          "qm-bad",
          selfPick !== undefined && idx === selfPick && selfPick !== correct,
        );
        b.classList.toggle("qm-dim", idx !== correct && idx !== selfPick);
      });
      const firstNick = msg.firstCorrectId
        ? players.find((p) => p.playerId === msg.firstCorrectId)?.nickname
        : null;
      if (firstNick) {
        bannerEl.textContent = `⚡ ${firstNick} was fastest +3`;
      } else {
        bannerEl.textContent = "nobody got it 😬";
      }
      updateBoard(msg.scores, msg.roundPoints);
    } else {
      bannerEl.textContent = "final scores";
      updateBoard(msg.scores);
    }

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

const QuickMathClient: MiniGameClientDefinition = {
  id: "quick-math",
  controlsHint: "solve it, tap the answer — fastest correct scores +3",
  createMatch: createQuickMathMatchClient,
};

registerMiniGameClient(QuickMathClient);

export default QuickMathClient;
