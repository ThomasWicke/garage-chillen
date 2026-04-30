// TournamentGamemode — single-elimination bracket where matches in the same
// round play in PARALLEL, then everyone waits on the bracket overlay until
// all matches in the round complete, then the next round starts.
//
// Phases (per gamemode session):
//   intro        – bracket displayed for INTRO_MS, no matches running
//   round        – all matches in `currentRound` running concurrently
//   between      – between rounds (all current-round matches done) for
//                  BETWEEN_MS, then advance to the next round
//   complete     – bracket complete; gamemode calls endRound and tears down
//
// Per-player view derived from gamemode messages:
//   • participating in an active match → mini-game's match scene
//   • waiting (bye, finished, intro/between phase) → bracket overlay
//
// Universal match timeout: the match SHOULD self-end at `deadlineAt` with a
// leader-wins rule. If it hasn't ended `MATCH_FORCE_GRACE_MS` past the
// deadline, the gamemode force-ends with a draw (random winner).

import {
  buildBracket,
  isComplete,
  placements,
  placementsToPoints,
  recordMatchResult,
  type Bracket,
  type BracketMatch,
} from "../../bracket";
import type { MatchContext, MatchSession } from "../../minigames/types";
import { registerGamemode } from "../registry";
import type {
  GamemodeContext,
  GamemodeDefinition,
  GamemodeSession,
  MatchEndResult,
  MiniGamePlayer,
} from "../types";

const INTRO_MS = 8_000;
const BETWEEN_MS = 5_000;
const MATCH_FORCE_GRACE_MS = 5_000;

type Phase = "intro" | "round" | "between" | "complete";

type ActiveMatch = {
  matchId: string;
  participants: MiniGamePlayer[];
  participantIds: string[];
  session: MatchSession;
  deadlineAt: number;
  ended: boolean;
  /** Set when the match ended; bracket already updated. */
  result: MatchEndResult | null;
};

function createTournamentSession(ctx: GamemodeContext): GamemodeSession {
  const lobbyPlayers = ctx.lobbyPlayers;
  if (lobbyPlayers.length < 2) {
    throw new Error("Tournament requires at least 2 lobby players");
  }
  const lobbyIds = lobbyPlayers.map((p) => p.playerId);
  const bracket = buildBracket(lobbyIds);

  let phase: Phase = "intro";
  let phaseEndsAt = Date.now() + INTRO_MS;
  let currentRound = 0;
  let phaseTimer: ReturnType<typeof setTimeout> | null = null;
  const activeMatches = new Map<string, ActiveMatch>();
  let ended = false;

  const playerById = new Map<string, MiniGamePlayer>();
  for (const p of lobbyPlayers) playerById.set(p.playerId, p);
  /** Players who disconnected while the gamemode is running. They forfeit
   *  any future match they would otherwise play. */
  const disconnectedIds = new Set<string>();

  // ─── helpers ─────────────────────────────────────────────────────────────

  function broadcastBracketState() {
    ctx.broadcastGamemode({
      type: "bracket-state",
      phase,
      currentRound,
      phaseEndsAt: phase === "intro" || phase === "between" ? phaseEndsAt : null,
      bracket: toPublicBracket(bracket),
      activeMatches: [...activeMatches.values()].map((m) => ({
        matchId: m.matchId,
        participants: m.participantIds,
      })),
    });
  }

  function clearPhaseTimer() {
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }
  }

  function setEveryoneClicker(available: boolean) {
    for (const p of lobbyPlayers) {
      ctx.setClickerAvailable(p.playerId, available);
    }
  }

  // ─── phase transitions ───────────────────────────────────────────────────

  function startCurrentRoundMatches() {
    if (ended) return;
    // Advance through any rounds with no playable matches (shouldn't happen
    // post-construction since we don't cascade byes, but defensive).
    while (currentRound < bracket.rounds) {
      const playable = bracket.matches.filter(
        (m) =>
          m.round === currentRound &&
          m.winner === null &&
          m.a !== null &&
          m.b !== null,
      );
      if (playable.length > 0) {
        spinUpMatches(playable);
        return;
      }
      // No playable matches in this round (all auto-resolved). Step on.
      currentRound++;
    }
    // Past the last round → bracket should be complete.
    if (isComplete(bracket)) {
      enterCompletePhase();
    } else {
      // Defensive: bracket has unfinished match but no playable rounds.
      ctx.log("[tournament] bracket stuck — finalizing anyway");
      enterCompletePhase();
    }
  }

  function spinUpMatches(matches: BracketMatch[]) {
    phase = "round";
    setEveryoneClicker(true);
    const now = Date.now();

    type Plan = {
      bracketMatch: BracketMatch;
      participants: MiniGamePlayer[];
      participantIds: string[];
      deadlineAt: number;
    };
    const plans: Plan[] = [];

    for (const m of matches) {
      const aRec = m.a ? playerById.get(m.a) : null;
      const bRec = m.b ? playerById.get(m.b) : null;
      const aGone = !aRec || disconnectedIds.has(aRec.playerId);
      const bGone = !bRec || disconnectedIds.has(bRec.playerId);
      if (aGone || bGone) {
        const survivor = !aGone
          ? aRec?.playerId
          : !bGone
            ? bRec?.playerId
            : (aRec?.playerId ?? bRec?.playerId);
        if (survivor) {
          recordMatchResult(bracket, m.matchId, survivor);
        }
        continue;
      }
      const participants: MiniGamePlayer[] = [aRec, bRec];
      const participantIds = participants.map((p) => p.playerId);
      plans.push({
        bracketMatch: m,
        participants,
        participantIds,
        deadlineAt: now + ctx.miniGame.matchTimeoutMs,
      });
    }

    // Step 1 — register active matches with placeholder sessions and flip
    //          clicker for active participants.
    for (const plan of plans) {
      const placeholder: ActiveMatch = {
        matchId: plan.bracketMatch.matchId,
        participants: plan.participants,
        participantIds: plan.participantIds,
        session: null as unknown as MatchSession,
        deadlineAt: plan.deadlineAt,
        ended: false,
        result: null,
      };
      activeMatches.set(plan.bracketMatch.matchId, placeholder);
      for (const pid of plan.participantIds) {
        ctx.setClickerAvailable(pid, false);
      }
    }

    // Step 2 — broadcast the bracket-state BEFORE creating match sessions.
    //          This ensures clients mount their match scene in time to
    //          receive the welcome/state messages emitted by createMatch.
    broadcastBracketState();

    // Step 3 — create the actual match sessions. Each one will synchronously
    //          send welcome + first state via ctx.broadcastMatch.
    for (const plan of plans) {
      const am = activeMatches.get(plan.bracketMatch.matchId);
      if (!am) continue;
      const matchCtx: MatchContext = {
        matchId: plan.bracketMatch.matchId,
        players: plan.participants,
        deadlineAt: plan.deadlineAt,
        broadcast: (msg) =>
          ctx.broadcastMatch(plan.bracketMatch.matchId, plan.participantIds, msg),
        sendTo: (pid, msg) =>
          ctx.sendMatch(plan.bracketMatch.matchId, pid, msg),
        endMatch: (result) =>
          completeMatch(plan.bracketMatch.matchId, result),
        log: (...args) =>
          ctx.log(`[match ${plan.bracketMatch.matchId}]`, ...args),
      };
      am.session = ctx.miniGame.createMatch(matchCtx);
    }

    // Edge case: nothing to run (all forfeited). Step on.
    if (activeMatches.size === 0) {
      maybeAdvanceFromRound();
    }
  }

  function completeMatch(matchId: string, result: MatchEndResult) {
    if (ended) return;
    const am = activeMatches.get(matchId);
    if (!am || am.ended) return;
    am.ended = true;
    am.result = result;
    try {
      am.session.cleanup();
    } catch (e) {
      ctx.log(`[tournament] match cleanup error`, e);
    }
    activeMatches.delete(matchId);

    // Pick a winner. If null/draw → arbitrary first participant.
    let winner = result.winnerId;
    if (!winner || !am.participantIds.includes(winner)) {
      winner = am.participantIds[0];
    }
    recordMatchResult(bracket, matchId, winner);

    // Both participants of finished match: clicker available (waiting).
    for (const pid of am.participantIds) {
      ctx.setClickerAvailable(pid, true);
    }

    // Tell everyone the match ended (so participants can fade from match scene
    // back to bracket overlay).
    ctx.broadcastMatch(matchId, am.participantIds, {
      type: "match-ended",
      winnerId: winner,
      scores: result.scores ?? null,
      summary: result.summary ?? null,
    });

    broadcastBracketState();
    maybeAdvanceFromRound();
  }

  function maybeAdvanceFromRound() {
    if (ended) return;
    // Are any matches in `currentRound` still active?
    const stillRunning = [...activeMatches.values()].some((am) => {
      const m = bracket.matches.find((b) => b.matchId === am.matchId);
      return m?.round === currentRound;
    });
    if (stillRunning) return;

    if (isComplete(bracket)) {
      enterCompletePhase();
      return;
    }
    enterBetweenPhase();
  }

  function enterBetweenPhase() {
    phase = "between";
    phaseEndsAt = Date.now() + BETWEEN_MS;
    setEveryoneClicker(true);
    broadcastBracketState();
    clearPhaseTimer();
    phaseTimer = setTimeout(() => {
      phaseTimer = null;
      if (ended) return;
      currentRound++;
      startCurrentRoundMatches();
    }, BETWEEN_MS);
  }

  function enterCompletePhase() {
    phase = "complete";
    setEveryoneClicker(true);
    broadcastBracketState();
    finalize();
  }

  function finalize() {
    if (ended) return;
    ended = true;
    clearPhaseTimer();
    const placement = placements(bracket);
    const points = placementsToPoints(placement);
    const champId = Object.entries(placement).find(([, p]) => p === 1)?.[0];
    const summary = champId
      ? `${playerById.get(champId)?.nickname ?? "?"} wins the tournament`
      : undefined;
    ctx.endRound({
      points,
      summary,
      participants: lobbyIds,
    });
  }

  // ─── tick (force timeouts) ───────────────────────────────────────────────

  function tickFn(dt: number) {
    if (ended) return;
    const now = Date.now();
    // Tick all active matches.
    for (const am of activeMatches.values()) {
      if (am.ended) continue;
      try {
        am.session.tick?.(dt);
      } catch (e) {
        ctx.log(`[tournament] match tick error`, e);
      }
    }
    // Force-end any match that's blown past its deadline + grace.
    for (const am of [...activeMatches.values()]) {
      if (am.ended) continue;
      if (now > am.deadlineAt + MATCH_FORCE_GRACE_MS) {
        ctx.log(`[tournament] force-ending stuck match ${am.matchId}`);
        completeMatch(am.matchId, {
          winnerId: null,
          summary: "match force-ended (timeout)",
        });
      }
    }
  }

  // ─── kick off ────────────────────────────────────────────────────────────

  // Intro: show the bracket for INTRO_MS, then start round-0 matches.
  setEveryoneClicker(true);
  broadcastBracketState();
  phaseTimer = setTimeout(() => {
    phaseTimer = null;
    if (ended) return;
    startCurrentRoundMatches();
  }, INTRO_MS);

  return {
    tick: tickFn,
    onMatchMessage(playerId, matchId, msg) {
      const am = activeMatches.get(matchId);
      if (!am || am.ended) return;
      if (!am.participantIds.includes(playerId)) return;
      am.session.onMessage(playerId, msg);
    },
    onGamemodeMessage(_playerId, _msg) {
      // No gamemode-level inbound messages yet (could be used for "ready up").
    },
    onPlayerLeft(playerId) {
      disconnectedIds.add(playerId);
      // Forfeit any active match this player is in.
      for (const am of [...activeMatches.values()]) {
        if (am.ended) continue;
        if (!am.participantIds.includes(playerId)) continue;
        const opponentId = am.participantIds.find((pid) => pid !== playerId);
        const opponentNick = opponentId
          ? (playerById.get(opponentId)?.nickname ?? "opponent")
          : "opponent";
        try {
          am.session.onPlayerLeft?.(playerId);
        } catch (e) {
          ctx.log(`[tournament] match.onPlayerLeft error`, e);
        }
        completeMatch(am.matchId, {
          winnerId: opponentId ?? null,
          summary: `${opponentNick} wins by forfeit`,
        });
      }
      // If the leaver had a future bye, they'll forfeit when that match starts.
    },
    cleanup() {
      ended = true;
      clearPhaseTimer();
      for (const am of activeMatches.values()) {
        try {
          am.session.cleanup();
        } catch {
          /* ignore */
        }
      }
      activeMatches.clear();
    },
  };
}

function toPublicBracket(bracket: Bracket) {
  return {
    rounds: bracket.rounds,
    matches: bracket.matches.map((m) => ({
      matchId: m.matchId,
      round: m.round,
      index: m.index,
      a: m.a,
      b: m.b,
      winner: m.winner,
    })),
  };
}

const TournamentDefinition: GamemodeDefinition = {
  id: "tournament",
  displayName: "Tournament",
  tickHz: 30,
  createSession: createTournamentSession,
};

registerGamemode(TournamentDefinition);

export default TournamentDefinition;
