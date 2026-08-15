// Penalty Shootout — tournament 1v1 mind-game. 6 rounds in halves: p1
// shoots rounds 1-3, then p2 shoots rounds 4-6. Each round both players
// secretly pick a zone
// (left / center / right): the shooter aims, the keeper dives. Goal iff
// the zones differ. Most goals after 6 rounds wins; still level → null
// winner (the gamemode coin-flips). No sudden death — playtest verdict:
// "3 me, 3 you, nothing more".
//
// Tick-driven phase machine per round:
//   "choosing" (5s — no pick: shooter gets a random zone, keeper stays
//   put = center) → "reveal" (2s: broadcast both choices + outcome) →
//   next round / end.
//
// ANTI-CHEAT: during "choosing" the state broadcast carries ONLY the
// boolean picked-flags — never the zones. Zones are first put on the wire
// inside `reveal` once the round is resolved.
//
// matchTimeoutMs is a safety net just past the 42s maximum; at the deadline
// the current leader wins (tie → null, gamemode resolves).

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const ZONES = ["left", "center", "right"] as const;
type Zone = (typeof ZONES)[number];

const CHOOSE_MS = 5_000;
const REVEAL_MS = 2_000;
const REG_ROUNDS = 6;
/** No extra rounds after regulation (playtest: "3 me, 3 you, nothing more"). */
const MAX_SUDDEN_DEATH_ROUNDS = 0;
/** 6 × (5s choose + 2s reveal) = 42s max; safety net just above. */
const PS_MATCH_TIMEOUT_MS = 55_000;

type Phase = "choosing" | "reveal" | "ended";

type Reveal = {
  round: number;
  shooterId: string;
  keeperId: string;
  shooterZone: Zone;
  keeperZone: Zone;
  /** False when the keeper never picked (defaults to center = "stays put"). */
  keeperPicked: boolean;
  scored: boolean;
};

type ServerState = {
  phase: Phase;
  /** 1-based round, 1..6. */
  round: number;
  goals: { p1: number; p2: number };
  phaseEndsAt: number;
  /** Secret picks for the current round — NEVER broadcast while choosing. */
  shooterChoice: Zone | null;
  keeperChoice: Zone | null;
  lastReveal: Reveal | null;
  ended: boolean;
};

function randomZone(): Zone {
  return ZONES[Math.floor(Math.random() * ZONES.length)];
}

function isZone(v: unknown): v is Zone {
  return typeof v === "string" && (ZONES as readonly string[]).includes(v);
}

function createPenaltyShootoutMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) {
    throw new Error("Penalty Shootout requires exactly 2 participants");
  }

  const state: ServerState = {
    phase: "choosing",
    round: 1,
    goals: { p1: 0, p2: 0 },
    // Anchored to startAt: warm-up must not eat into round 1's 5 seconds.
    phaseEndsAt: ctx.startAt + CHOOSE_MS,
    shooterChoice: null,
    keeperChoice: null,
    lastReveal: null,
    ended: false,
  };

  // Played in HALVES (playtest feedback — alternating every round made the
  // role flip-flop confusing): rounds 1-3 p1 shoots, rounds 4-6 p2 shoots.
  // (The `> REG_ROUNDS` branch is only reachable if sudden death is ever
  // re-enabled via MAX_SUDDEN_DEATH_ROUNDS.)
  function shooter(): typeof p1 {
    if (state.round <= REG_ROUNDS) {
      return state.round <= REG_ROUNDS / 2 ? p1 : p2;
    }
    return state.round % 2 === 1 ? p1 : p2;
  }
  function keeper(): typeof p1 {
    return shooter() === p1 ? p2 : p1;
  }

  ctx.broadcast({
    type: "welcome",
    regRounds: REG_ROUNDS,
    chooseMs: CHOOSE_MS,
    revealMs: REVEAL_MS,
    deadlineAt: ctx.deadlineAt,
    players: {
      p1: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
      p2: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
    },
  });

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      round: state.round,
      regRounds: REG_ROUNDS,
      suddenDeath: state.round > REG_ROUNDS,
      shooterId: shooter().playerId,
      keeperId: keeper().playerId,
      goals: { p1: state.goals.p1, p2: state.goals.p2 },
      phaseEndsAt: state.phaseEndsAt,
      // Choosing phase: only booleans go on the wire — never the zones.
      shooterPicked: state.shooterChoice !== null,
      keeperPicked: state.keeperChoice !== null,
      // Zones appear here only once the round is resolved.
      reveal: state.phase === "reveal" ? state.lastReveal : null,
      deadlineAt: ctx.deadlineAt,
    });
  }

  broadcastState();

  function resolveRound(now: number) {
    const shooterZone = state.shooterChoice ?? randomZone(); // no pick → random
    const keeperZone = state.keeperChoice ?? "center"; // keeper stays put
    const scored = shooterZone !== keeperZone;
    if (scored) {
      if (shooter().playerId === p1.playerId) state.goals.p1++;
      else state.goals.p2++;
    }
    state.lastReveal = {
      round: state.round,
      shooterId: shooter().playerId,
      keeperId: keeper().playerId,
      shooterZone,
      keeperZone,
      keeperPicked: state.keeperChoice !== null,
      scored,
    };
    state.phase = "reveal";
    state.phaseEndsAt = now + REVEAL_MS;
  }

  /** After a reveal finishes: end the match or start the next round. */
  function advance(now: number) {
    const r = state.round;
    // Decision point: after round 6 (and after each completed pair if
    // sudden death is ever re-enabled).
    const pairComplete =
      r === REG_ROUNDS ||
      (r > REG_ROUNDS && (r - REG_ROUNDS) % 2 === 0);
    if (pairComplete && state.goals.p1 !== state.goals.p2) {
      endByGoals();
      return;
    }
    // Decided early? p1 has finished shooting after round 3, so p2 leading
    // at any point wins; p1 wins once p2's remaining shots can't catch up.
    if (r >= REG_ROUNDS / 2 && r < REG_ROUNDS) {
      const p2Remaining = REG_ROUNDS - r;
      if (
        state.goals.p2 > state.goals.p1 ||
        state.goals.p1 > state.goals.p2 + p2Remaining
      ) {
        endByGoals();
        return;
      }
    }
    if (r >= REG_ROUNDS + MAX_SUDDEN_DEATH_ROUNDS) {
      // Still level after the last round → null winner (coin flip).
      endLevel();
      return;
    }
    state.round = r + 1;
    state.shooterChoice = null;
    state.keeperChoice = null;
    state.phase = "choosing";
    state.phaseEndsAt = now + CHOOSE_MS;
  }

  function endByGoals() {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    broadcastState();
    const p1Won = state.goals.p1 > state.goals.p2;
    const winner = p1Won ? p1 : p2;
    ctx.endMatch({
      winnerId: winner.playerId,
      scores: {
        [p1.playerId]: state.goals.p1,
        [p2.playerId]: state.goals.p2,
      },
      summary: `${winner.nickname} wins the shootout ${Math.max(state.goals.p1, state.goals.p2)}–${Math.min(state.goals.p1, state.goals.p2)}`,
    });
  }

  function endLevel() {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    broadcastState();
    ctx.endMatch({
      winnerId: null, // level after 6 → the gamemode coin-flips
      scores: {
        [p1.playerId]: state.goals.p1,
        [p2.playerId]: state.goals.p2,
      },
      summary: `level ${state.goals.p1}–${state.goals.p2} after six · coin flip`,
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    broadcastState();
    let winnerId: string | null;
    if (state.goals.p1 > state.goals.p2) winnerId = p1.playerId;
    else if (state.goals.p2 > state.goals.p1) winnerId = p2.playerId;
    else winnerId = null;
    const summary =
      winnerId === null
        ? `time's up · level ${state.goals.p1}–${state.goals.p2}`
        : `time's up · ${winnerId === p1.playerId ? p1.nickname : p2.nickname} leads ${Math.max(state.goals.p1, state.goals.p2)}–${Math.min(state.goals.p1, state.goals.p2)}`;
    ctx.endMatch({
      winnerId,
      scores: {
        [p1.playerId]: state.goals.p1,
        [p2.playerId]: state.goals.p2,
      },
      summary,
    });
  }

  return {
    tick() {
      if (state.ended) return;
      const now = Date.now();
      if (now < ctx.startAt) {
        // Warm-up: phase timers frozen (phaseEndsAt is anchored to
        // startAt); keep broadcasting so clients can render the scene.
        broadcastState();
        return;
      }
      if (now >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      if (state.phase === "choosing") {
        const bothPicked =
          state.shooterChoice !== null && state.keeperChoice !== null;
        if (bothPicked || now >= state.phaseEndsAt) resolveRound(now);
      } else if (state.phase === "reveal") {
        if (now >= state.phaseEndsAt) advance(now);
      }
      if (state.ended) return; // advance() may have ended the match
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "pick") return;
      if (state.phase !== "choosing") return;
      if (!isZone(msg.zone)) return;
      // Only the two round roles may pick; a pick may be changed until the
      // choosing phase resolves. Choices stay server-side until reveal.
      if (playerId === shooter().playerId) state.shooterChoice = msg.zone;
      else if (playerId === keeper().playerId) state.keeperChoice = msg.zone;
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (playerId === p1.playerId || playerId === p2.playerId) {
        const survivorId = playerId === p1.playerId ? p2.playerId : p1.playerId;
        const survivorNick =
          survivorId === p1.playerId ? p1.nickname : p2.nickname;
        state.ended = true;
        state.phase = "ended";
        ctx.endMatch({
          winnerId: survivorId,
          summary: `${survivorNick} wins by forfeit`,
        });
      }
    },
    cleanup() {
      // No external resources.
    },
  };
}

const PenaltyShootoutDefinition: MiniGameDefinition = {
  id: "penalty-shootout",
  displayName: "Penalty Shootout",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: PS_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createPenaltyShootoutMatch,
};

registerMiniGame(PenaltyShootoutDefinition);

export default PenaltyShootoutDefinition;
