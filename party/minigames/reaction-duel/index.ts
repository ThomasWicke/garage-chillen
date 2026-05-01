// Reaction Duel — tournament 1v1, best-of-5. Each round: server arms (random
// 1.5–4s delay), then signals "GO!". First tap after the signal wins the
// round; tapping early loses the round.
//
// State broadcast covers all phases so spectators see the same color cues
// participants do.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const ROUNDS = 5;
const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 4000;
const RESULT_HOLD_MS = 1800;
const RD_MATCH_TIMEOUT_MS = 90_000;

type Phase = "armed" | "go" | "result" | "ended";

type RoundResult = {
  winner: "p1" | "p2" | null;
  reason: "first-tap" | "early-tap" | "draw";
  p1ReactionMs: number | null;
  p2ReactionMs: number | null;
};

type GameState = {
  scores: { p1: number; p2: number };
  currentRound: number;
  phase: Phase;
  /** Server-time at which the GO signal fires (during "armed"), or fired (during "go"). */
  signalAt: number;
  /** Server-time when current phase ends (e.g. result phase auto-advance). */
  phaseEndsAt: number;
  /** Per-round result for client display during "result" phase. */
  roundResult: RoundResult | null;
  /** Whether each player has tapped this round (latched, prevents spam). */
  tapped: { p1: boolean; p2: boolean };
};

function createReactionDuelMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) throw new Error("Reaction Duel requires exactly 2 participants");

  const state: GameState = {
    scores: { p1: 0, p2: 0 },
    currentRound: 0,
    phase: "armed",
    signalAt: 0,
    phaseEndsAt: 0,
    roundResult: null,
    tapped: { p1: false, p2: false },
  };
  scheduleArmed();

  ctx.broadcast({
    type: "welcome",
    rounds: ROUNDS,
    deadlineAt: ctx.deadlineAt,
    players: {
      p1: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
      p2: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
    },
  });

  function scheduleArmed() {
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    state.phase = "armed";
    state.signalAt = Date.now() + delay;
    state.phaseEndsAt = state.signalAt;
    state.tapped = { p1: false, p2: false };
    state.roundResult = null;
  }

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      scores: state.scores,
      currentRound: state.currentRound,
      totalRounds: ROUNDS,
      phase: state.phase,
      signalAt: state.signalAt,
      phaseEndsAt: state.phaseEndsAt,
      roundResult: state.roundResult,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function awardRound(winner: "p1" | "p2" | null, reason: RoundResult["reason"], p1Ms: number | null, p2Ms: number | null) {
    if (winner) state.scores[winner]++;
    state.roundResult = {
      winner,
      reason,
      p1ReactionMs: p1Ms,
      p2ReactionMs: p2Ms,
    };
    state.phase = "result";
    state.phaseEndsAt = Date.now() + RESULT_HOLD_MS;
  }

  function advanceAfterResult() {
    state.currentRound++;
    if (state.currentRound >= ROUNDS) {
      endByScore();
      return;
    }
    scheduleArmed();
  }

  function endByScore() {
    if (state.phase === "ended") return;
    state.phase = "ended";
    broadcastState();
    let winnerId: string | null;
    let summary: string;
    if (state.scores.p1 > state.scores.p2) {
      winnerId = p1.playerId;
      summary = `${p1.nickname} wins ${state.scores.p1}–${state.scores.p2}`;
    } else if (state.scores.p2 > state.scores.p1) {
      winnerId = p2.playerId;
      summary = `${p2.nickname} wins ${state.scores.p2}–${state.scores.p1}`;
    } else {
      winnerId = null;
      summary = `tie ${state.scores.p1}–${state.scores.p2}`;
    }
    ctx.endMatch({
      winnerId,
      scores: { [p1.playerId]: state.scores.p1, [p2.playerId]: state.scores.p2 },
      summary,
    });
  }

  function endByDeadline() {
    if (state.phase === "ended") return;
    state.phase = "ended";
    broadcastState();
    let winnerId: string | null;
    if (state.scores.p1 > state.scores.p2) winnerId = p1.playerId;
    else if (state.scores.p2 > state.scores.p1) winnerId = p2.playerId;
    else winnerId = null;
    const summary =
      winnerId === null
        ? `time's up · tie ${state.scores.p1}–${state.scores.p2}`
        : `time's up · ${winnerId === p1.playerId ? p1.nickname : p2.nickname} leads`;
    ctx.endMatch({
      winnerId,
      scores: { [p1.playerId]: state.scores.p1, [p2.playerId]: state.scores.p2 },
      summary,
    });
  }

  return {
    tick() {
      if (state.phase === "ended") return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      const now = Date.now();
      if (state.phase === "armed" && now >= state.signalAt) {
        state.phase = "go";
        // No phaseEndsAt for "go" — ends when someone taps.
        state.phaseEndsAt = 0;
      } else if (state.phase === "result" && now >= state.phaseEndsAt) {
        advanceAfterResult();
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (msg.type !== "tap") return;
      if (state.phase === "ended") return;
      const slot = playerId === p1.playerId ? "p1" : playerId === p2.playerId ? "p2" : null;
      if (!slot) return;
      if (state.tapped[slot]) return;
      state.tapped[slot] = true;
      const now = Date.now();
      if (state.phase === "armed") {
        // Early tap → opponent wins this round.
        const winner = slot === "p1" ? "p2" : "p1";
        awardRound(winner, "early-tap", null, null);
      } else if (state.phase === "go") {
        const reactionMs = now - state.signalAt;
        // Mark this player's reaction. If both tapped, decide.
        const otherSlot = slot === "p1" ? "p2" : "p1";
        if (state.tapped[otherSlot]) {
          // Both tapped — we already awarded when first tap landed.
          // (Shouldn't reach here often because we end the round on first.)
          return;
        }
        // First tap wins the round.
        awardRound(slot, "first-tap", slot === "p1" ? reactionMs : null, slot === "p2" ? reactionMs : null);
      }
      // Result phase will be handled in tick.
    },
    onPlayerLeft(playerId) {
      if (state.phase === "ended") return;
      if (playerId !== p1.playerId && playerId !== p2.playerId) return;
      const survivor = playerId === p1.playerId ? p2 : p1;
      state.phase = "ended";
      ctx.endMatch({
        winnerId: survivor.playerId,
        summary: `${survivor.nickname} wins by forfeit`,
      });
    },
    cleanup() {},
  };
}

const ReactionDuelDefinition: MiniGameDefinition = {
  id: "reaction-duel",
  displayName: "Reaction Duel",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: RD_MATCH_TIMEOUT_MS,
  shuffleWeight: 4,
  createMatch: createReactionDuelMatch,
};

registerMiniGame(ReactionDuelDefinition);

export default ReactionDuelDefinition;
