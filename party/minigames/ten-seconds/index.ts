// Ten Seconds — last-man-standing FFA. Blind time-perception: each round a
// timer counts up visibly until 3.00s, then the display vanishes and players
// keep counting in their heads, tapping STOP when they believe exactly
// 10.00s have elapsed. Closest to 10.00 wins the round (+3, second-best +1).
// 3 rounds; most total points wins the match.
//
// Tick-driven phase machine: arm (2.5s) → counting (until everyone tapped or
// 16s) → results (5s) → next round / end. Round 1's arm anchors to startAt
// so the warm-up overlay doesn't eat the get-ready window.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const ROUNDS = 3;
const ARM_MS = 2_500;
/** The count-up display is visible for this long, then hides (client-side). */
const VISIBLE_MS = 3_000;
const TARGET_MS = 10_000;
/** Counting force-ends this long after roundStartAt (covers AFK players). */
const MAX_COUNT_MS = 16_000;
const RESULTS_MS = 5_000;
/** Errors are clamped so a no-show tap at 16s isn't infinitely worse. */
const MAX_ERROR_MS = 5_000;
const TS_MATCH_TIMEOUT_MS = 120_000;

type Phase = "arm" | "counting" | "results";

type RoundRow = {
  playerId: string;
  /** null = didn't tap this round. */
  elapsedMs: number | null;
  /** Signed ms vs the 10.00s target (clamped to ±MAX_ERROR_MS); null = no tap. */
  signedErrorMs: number | null;
  /** Points awarded for this round (0 for everyone but the top two groups). */
  roundPoints: number;
};

type GameState = {
  phase: Phase;
  round: number; // 1-based
  /** Arm/results phase end time (server ms). Unused during counting. */
  phaseUntil: number;
  /** Server timestamp the current round's count started at. 0 = not started. */
  roundStartAt: number;
  /** Counting force-end time. */
  countingUntil: number;
  /** This round's taps: playerId → elapsedMs (int). */
  taps: Map<string, number>;
  /** Total points across rounds. */
  points: Map<string, number>;
  /** Participants still connected (leavers are removed so counting ends). */
  connected: Set<string>;
  left: Set<string>;
  /** Results of the round being shown during the results phase. */
  roundResults: RoundRow[] | null;
  ended: boolean;
};

function createTenSecondsMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;

  const state: GameState = {
    phase: "arm",
    round: 1,
    // Round 1's arm anchors to startAt: warm-up is frozen, so the 2.5s
    // get-ready window must start counting at GO, not at match creation.
    phaseUntil: ctx.startAt + ARM_MS,
    roundStartAt: 0,
    countingUntil: 0,
    taps: new Map(),
    points: new Map(players.map((p) => [p.playerId, 0])),
    connected: new Set(players.map((p) => p.playerId)),
    left: new Set(),
    roundResults: null,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    rounds: ROUNDS,
    armMs: ARM_MS,
    visibleMs: VISIBLE_MS,
    targetMs: TARGET_MS,
    maxCountMs: MAX_COUNT_MS,
    resultsMs: RESULTS_MS,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    const totals: Record<string, number> = {};
    for (const [pid, pts] of state.points) totals[pid] = pts;
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      round: state.round,
      rounds: ROUNDS,
      phaseUntil: state.phaseUntil,
      roundStartAt: state.roundStartAt,
      // Who has locked in this round — but never their times (suspense until
      // results; broadcast reaches spectators too).
      tappedIds: [...state.taps.keys()],
      totals,
      // Round results only exist (and are only revealed) during the results
      // phase. Re-broadcast every tick → reconnects during results resync.
      results: state.phase === "results" ? state.roundResults : null,
      deadlineAt: ctx.deadlineAt,
    });
  }

  /** Score the just-finished round: sort taps by |error| asc, award +3 to the
   *  best error group and +1 to the group at rank 2 (exact-error ties share
   *  the reward — each tied player gets the full amount; a 2-way tie for best
   *  occupies ranks 1+2, so no +1 is given below it). */
  function finishRound() {
    type Entry = { playerId: string; elapsedMs: number; errorMs: number };
    const entries: Entry[] = [];
    for (const [pid, elapsedMs] of state.taps) {
      const errorMs = Math.min(Math.abs(elapsedMs - TARGET_MS), MAX_ERROR_MS);
      entries.push({ playerId: pid, elapsedMs, errorMs });
    }
    entries.sort((a, b) => a.errorMs - b.errorMs);

    const rows: RoundRow[] = [];
    let pos = 1;
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (j < entries.length && entries[j].errorMs === entries[i].errorMs) j++;
      const reward = pos === 1 ? 3 : pos === 2 ? 1 : 0;
      for (let g = i; g < j; g++) {
        const e = entries[g];
        if (reward > 0) {
          state.points.set(e.playerId, (state.points.get(e.playerId) ?? 0) + reward);
        }
        const signed = Math.max(
          -MAX_ERROR_MS,
          Math.min(MAX_ERROR_MS, e.elapsedMs - TARGET_MS),
        );
        rows.push({
          playerId: e.playerId,
          elapsedMs: e.elapsedMs,
          signedErrorMs: signed,
          roundPoints: reward,
        });
      }
      pos += j - i;
      i = j;
    }
    // No-taps trail the list as "—" rows (they get nothing).
    for (const p of players) {
      if (!state.taps.has(p.playerId)) {
        rows.push({
          playerId: p.playerId,
          elapsedMs: null,
          signedErrorMs: null,
          roundPoints: 0,
        });
      }
    }
    state.roundResults = rows;
    state.phase = "results";
    state.phaseUntil = Date.now() + RESULTS_MS;
  }

  /** Final placements: total points desc, grouped shared ranks. Leavers rank
   *  below connected players on equal points (forfeit nod), but points still
   *  count. */
  function computePlacements(): Record<string, number> {
    type Entry = { playerId: string; points: number; left: boolean };
    const entries: Entry[] = players.map((p) => ({
      playerId: p.playerId,
      points: state.points.get(p.playerId) ?? 0,
      left: state.left.has(p.playerId),
    }));
    entries.sort((a, b) => {
      if (a.points !== b.points) return b.points - a.points;
      if (a.left !== b.left) return a.left ? 1 : -1;
      return 0;
    });
    const out: Record<string, number> = {};
    let rank = 1;
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (
        j < entries.length &&
        entries[j].points === entries[i].points &&
        entries[j].left === entries[i].left
      ) {
        j++;
      }
      for (let g = i; g < j; g++) out[entries[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    return out;
  }

  function endWithPlacements(reason: "rounds" | "deadline") {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const scores: Record<string, number> = {};
    for (const [pid, pts] of state.points) scores[pid] = pts;
    let summary: string;
    if (winnerId) {
      const nick = players.find((p) => p.playerId === winnerId)?.nickname ?? "?";
      const pts = state.points.get(winnerId) ?? 0;
      summary =
        reason === "deadline"
          ? `time's up · ${nick} leads with ${pts} pts`
          : `${nick} wins · ${pts} pts`;
    } else {
      const nicks = topIds
        .map((id) => players.find((p) => p.playerId === id)?.nickname ?? "?")
        .join(" & ");
      const pts = topIds.length > 0 ? (state.points.get(topIds[0]) ?? 0) : 0;
      summary = `${nicks} tie · ${pts} pts`;
    }
    broadcastState();
    ctx.endMatch({ winnerId, placements, scores, summary });
  }

  return {
    tick() {
      if (state.ended) return;
      const now = Date.now();
      if (now >= ctx.deadlineAt) {
        endWithPlacements("deadline");
        return;
      }
      if (now < ctx.startAt) {
        // Warm-up: clients render the frozen arm screen; nothing advances.
        broadcastState();
        return;
      }

      if (state.phase === "arm") {
        if (now >= state.phaseUntil) {
          state.phase = "counting";
          // Anchor to the scheduled arm end (≤ one tick in the past) so the
          // count is deterministic, not tick-jittered.
          state.roundStartAt = state.phaseUntil;
          state.countingUntil = state.roundStartAt + MAX_COUNT_MS;
          state.taps.clear();
        }
      } else if (state.phase === "counting") {
        const allTapped =
          state.connected.size > 0 &&
          [...state.connected].every((pid) => state.taps.has(pid));
        if (allTapped || state.connected.size === 0 || now >= state.countingUntil) {
          finishRound();
        }
      } else if (state.phase === "results") {
        if (now >= state.phaseUntil) {
          if (state.round >= ROUNDS) {
            endWithPlacements("rounds");
            return;
          }
          state.round += 1;
          state.phase = "arm";
          state.phaseUntil = now + ARM_MS;
          state.roundStartAt = 0;
          state.taps.clear();
          state.roundResults = null;
        }
      }

      if (state.ended) return;
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "stop") return;
      if (!state.points.has(playerId)) return; // not a participant
      if (state.left.has(playerId)) return;
      if (state.phase !== "counting") return; // arm/results taps ignored
      if (state.taps.has(playerId)) return; // double-tap ignored
      const now = Date.now();
      if (state.roundStartAt <= 0 || now < state.roundStartAt) return;
      const elapsedMs = Math.round(now - state.roundStartAt);
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      state.taps.set(playerId, elapsedMs);
      // Round-end (everyone tapped) is detected on the next tick.
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!state.points.has(playerId)) return;
      state.connected.delete(playerId);
      state.left.add(playerId);
      // Their existing points and this round's tap (if any) stand; counting
      // just no longer waits on them.
    },
    cleanup() {},
  };
}

const TenSecondsDefinition: MiniGameDefinition = {
  id: "ten-seconds",
  displayName: "Ten Seconds",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: TS_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createTenSecondsMatch,
};

registerMiniGame(TenSecondsDefinition);

export default TenSecondsDefinition;
