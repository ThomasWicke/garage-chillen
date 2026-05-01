// Reaction Duel client. Pure DOM scene — no Kaplay needed. Big colored
// background fills the screen; tap anywhere to fire a tap event. Color
// signals the phase: red = wait, GREEN = GO, dim = result/intro.

import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Role = "p1" | "p2" | "spectator";
type Phase = "armed" | "go" | "result" | "ended";

type WelcomeMsg = {
  type: "welcome";
  rounds: number;
  deadlineAt: number;
  players: {
    p1: { playerId: string; nickname: string; avatarId: string };
    p2: { playerId: string; nickname: string; avatarId: string };
  };
};

type RoundResult = {
  winner: "p1" | "p2" | null;
  reason: "first-tap" | "early-tap" | "draw";
  p1ReactionMs: number | null;
  p2ReactionMs: number | null;
};

type StateMsg = {
  type: "state";
  scores: { p1: number; p2: number };
  currentRound: number;
  totalRounds: number;
  phase: Phase;
  signalAt: number;
  phaseEndsAt: number;
  roundResult: RoundResult | null;
};

function createReactionDuelMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="rd">
      <div class="rd-stage" id="rd-stage">
        <div class="rd-headline" id="rd-headline">connecting…</div>
        <div class="rd-sub" id="rd-sub"></div>
        <div class="rd-rounds" id="rd-rounds"></div>
      </div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#rd-stage")!;
  const headlineEl = ctx.container.querySelector<HTMLElement>("#rd-headline")!;
  const subEl = ctx.container.querySelector<HTMLElement>("#rd-sub")!;
  const roundsEl = ctx.container.querySelector<HTMLElement>("#rd-rounds")!;

  let role: Role = "spectator";
  let p1Nick = "P1";
  let p2Nick = "P2";

  function applyWelcome(msg: WelcomeMsg) {
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    p1Nick = msg.players.p1.nickname;
    p2Nick = msg.players.p2.nickname;
    headlineEl.textContent =
      role === "spectator" ? `${p1Nick} vs ${p2Nick}` : "get ready…";
  }

  function applyState(msg: StateMsg) {
    // Reset stage class.
    stageEl.classList.remove("phase-armed", "phase-go", "phase-result", "phase-ended");
    stageEl.classList.add(`phase-${msg.phase}`);

    const myScore = role === "p2" ? msg.scores.p2 : msg.scores.p1;
    const theirScore = role === "p2" ? msg.scores.p1 : msg.scores.p2;
    ctx.setMatchScore(`${myScore} – ${theirScore}`);

    roundsEl.textContent = `Round ${Math.min(msg.currentRound + 1, msg.totalRounds)} of ${msg.totalRounds}`;

    if (msg.phase === "armed") {
      headlineEl.textContent = "wait…";
      subEl.textContent = role === "spectator" ? "" : "don't tap yet";
    } else if (msg.phase === "go") {
      headlineEl.textContent = "GO!";
      subEl.textContent = role === "spectator" ? "" : "tap!";
    } else if (msg.phase === "result" && msg.roundResult) {
      const r = msg.roundResult;
      let line: string;
      if (r.winner === null) {
        line = "tie";
      } else if (r.reason === "early-tap") {
        const loser = r.winner === "p1" ? "p2" : "p1";
        const loserNick = loser === "p1" ? p1Nick : p2Nick;
        line = `${loserNick} jumped early`;
      } else {
        const winnerNick = r.winner === "p1" ? p1Nick : p2Nick;
        const ms = r.p1ReactionMs ?? r.p2ReactionMs ?? 0;
        line = `${winnerNick} · ${ms}ms`;
      }
      headlineEl.textContent = line;
      subEl.textContent = "";
    } else if (msg.phase === "ended") {
      headlineEl.textContent = "match over";
      subEl.textContent = "";
    }
  }

  // Tap handler — full-screen.
  let lastTapAt = 0;
  const tap = (e: Event) => {
    if (ctx.isSpectator) return;
    if (role !== "p1" && role !== "p2") return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastTapAt < 100) return; // dedupe touchstart vs synthesized click
    lastTapAt = now;
    ctx.send({ type: "tap" });
  };
  stageEl.addEventListener("touchstart", tap, { passive: false });
  stageEl.addEventListener("mousedown", tap);

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

const ReactionDuelClient: MiniGameClientDefinition = {
  id: "reaction-duel",
  createMatch: createReactionDuelMatchClient,
};

registerMiniGameClient(ReactionDuelClient);

export default ReactionDuelClient;
