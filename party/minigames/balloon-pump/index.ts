// Balloon Pump — last-man-standing FFA, press-your-luck. 3 rounds. Each
// round every player gets a balloon with a HIDDEN random pop threshold
// (uniform 8..24 pumps, server-side only). Tap PUMP to inflate (+1) or BANK
// to lock in the current pumps as round points. Hitting the threshold pops
// the balloon: 0 points this round. A round ends when everyone has banked or
// popped, or when the 20s round timer runs out (auto-bank). Highest total
// after 3 rounds wins; equal totals share a rank.
//
// Everyone acts simultaneously; every player's pump count and status is
// broadcast so the whole lobby watches all the balloons swell — that's the
// fun (and the mind games).

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const BP_ROUNDS = 3;
export const BP_ROUND_MS = 20_000;

const MIN_POP = 8;
const MAX_POP = 24; // inclusive
const RESULTS_MS = 3_000;
const BP_MATCH_TIMEOUT_MS = 120_000;

type Status = "pumping" | "banked" | "popped";
type Phase = "pumping" | "round-results" | "ended";

type PlayerState = {
  playerId: string;
  status: Status;
  pumps: number;
  /** Hidden — never broadcast. */
  threshold: number;
  roundPoints: number;
  total: number;
  left: boolean;
};

function randThreshold(): number {
  return MIN_POP + Math.floor(Math.random() * (MAX_POP - MIN_POP + 1));
}

function createBalloonPumpMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const states = new Map<string, PlayerState>();
  let phase: Phase = "pumping";
  let round = 1;
  // Round 1's timer counts from GO, not from match creation.
  let roundEndsAt = ctx.startAt + BP_ROUND_MS;
  let resultsUntil = 0;
  let ended = false;

  for (const p of players) {
    states.set(p.playerId, {
      playerId: p.playerId,
      status: "pumping",
      pumps: 0,
      threshold: randThreshold(),
      roundPoints: 0,
      total: 0,
      left: false,
    });
  }

  ctx.broadcast({
    type: "welcome",
    rounds: BP_ROUNDS,
    roundMs: BP_ROUND_MS,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
    deadlineAt: ctx.deadlineAt,
  });

  function broadcastState() {
    const playersObj: Record<string, unknown> = {};
    for (const [pid, s] of states) {
      playersObj[pid] = {
        status: s.status,
        pumps: s.pumps,
        roundPoints: s.roundPoints,
        total: s.total,
        left: s.left,
      };
    }
    ctx.broadcast({
      type: "state",
      phase,
      round,
      roundEndsAt,
      resultsUntil,
      players: playersObj,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function bank(s: PlayerState) {
    s.status = "banked";
    s.roundPoints = s.pumps;
    s.total += s.pumps;
  }

  /** Auto-bank everyone still pumping (round timer / deadline). */
  function autoBankRemaining() {
    for (const s of states.values()) {
      if (!s.left && s.status === "pumping") bank(s);
    }
  }

  function activeStates(): PlayerState[] {
    return [...states.values()].filter((s) => !s.left);
  }

  function finishRound() {
    autoBankRemaining();
    phase = "round-results";
    resultsUntil = Date.now() + RESULTS_MS;
  }

  function startNextRound() {
    round += 1;
    for (const s of states.values()) {
      if (s.left) continue;
      s.status = "pumping";
      s.pumps = 0;
      s.roundPoints = 0;
      s.threshold = randThreshold();
    }
    phase = "pumping";
    roundEndsAt = Math.max(Date.now(), ctx.startAt) + BP_ROUND_MS;
  }

  /** Placements by total points desc; equal totals SHARE a rank. Players who
   *  disconnected rank below everyone who stayed. */
  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const active = [...states.values()]
      .filter((s) => !s.left)
      .sort((a, b) => b.total - a.total);
    const forfeits = [...states.values()]
      .filter((s) => s.left)
      .sort((a, b) => b.total - a.total);
    let rank = 1;
    for (const group of [active, forfeits]) {
      let i = 0;
      while (i < group.length) {
        let j = i;
        while (j < group.length && group[j].total === group[i].total) j++;
        for (let g = i; g < j; g++) out[group[g].playerId] = rank;
        rank += j - i;
        i = j;
      }
    }
    return out;
  }

  function endMatchNow(timeUp: boolean) {
    if (ended) return;
    ended = true;
    phase = "ended";
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const topTotal = Math.max(
      0,
      ...topIds.map((id) => states.get(id)?.total ?? 0),
    );
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    const summary = winnerNick
      ? `${timeUp ? "time's up · " : ""}${winnerNick} wins · ${topTotal} pts`
      : `${timeUp ? "time's up · " : ""}tie at ${topTotal} pts`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, summary });
  }

  return {
    tick() {
      if (ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        // Graceful timeout: whatever is un-banked in the current round is
        // auto-banked, then totals decide.
        if (phase === "pumping") autoBankRemaining();
        endMatchNow(true);
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the frozen scene; nothing advances yet.
        broadcastState();
        return;
      }
      const now = Date.now();
      if (phase === "pumping") {
        const active = activeStates();
        const allDone =
          active.length === 0 ||
          active.every((s) => s.status !== "pumping");
        if (allDone || now >= roundEndsAt) {
          finishRound();
        }
      } else if (phase === "round-results") {
        if (now >= resultsUntil) {
          if (round >= BP_ROUNDS) {
            endMatchNow(false);
            return;
          }
          startNextRound();
        }
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (phase !== "pumping") return;
      const s = states.get(playerId);
      if (!s || s.left || s.status !== "pumping") return;
      if (msg.type === "pump") {
        s.pumps += 1;
        if (s.pumps >= s.threshold) {
          // POP — 0 points this round.
          s.status = "popped";
          s.roundPoints = 0;
        }
      } else if (msg.type === "bank") {
        bank(s);
      }
    },
    onPlayerLeft(playerId) {
      const s = states.get(playerId);
      if (!s) return;
      s.left = true;
      // Whatever they banked in earlier rounds stands, but the current
      // round's un-banked pumps are gone; they rank below everyone who
      // stayed regardless.
      if (s.status === "pumping") {
        s.status = "banked";
        s.roundPoints = 0;
      }
    },
    cleanup() {},
  };
}

const BalloonPumpDefinition: MiniGameDefinition = {
  id: "balloon-pump",
  displayName: "Balloon Pump",
  gamemode: "last-man-standing",
  // FFA — match takes the full lobby. matchSize is metadata only here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: BP_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createBalloonPumpMatch,
};

registerMiniGame(BalloonPumpDefinition);

export default BalloonPumpDefinition;
