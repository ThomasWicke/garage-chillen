// Spy Signal — last-man-standing social deduction, played IN THE ROOM.
// The phones only keep secrets and collect votes: every player secretly
// sees the same crew symbol except one spy, who sees a different one.
// Then everyone talks OUT LOUD and votes on who the spy is.
//
// 2 rounds, each a tick-driven phase machine:
//   peek (7s)    → secret symbol per player via sendTo (re-sent ~500ms)
//   discuss (35s)→ phones show nothing revealing; the room talks
//   vote (15s)   → tap an avatar; broadcast only WHO voted, never for whom
//   reveal (8s)  → spyId + both symbols + full tally + scoring
// Scoring: accused IS the spy → each correct voter +3, spy 0.
//          accused is NOT the spy → spy +6, everyone else 0.
// Spy disconnects mid-round → round ends immediately, everyone else +1.
// Placements after round 2: total points desc, ties share rank.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const PEEK_MS = 7_000;
const DISCUSS_MS = 35_000;
const VOTE_MS = 15_000;
const REVEAL_MS = 8_000;
const TOTAL_ROUNDS = 2;
const SECRET_RESEND_MS = 500;
const SS_MATCH_TIMEOUT_MS = 240_000;

/** Crew sprite keys the client can render. */
const SYMBOL_POOL = [
  "apple",
  "ghosty",
  "heart",
  "moon",
  "star",
  "fire",
  "coin",
  "mushroom",
  "sword",
  "egg",
];

type Phase = "peek" | "discuss" | "vote" | "reveal" | "ended";

type Reveal = {
  spyId: string;
  spyNickname: string;
  targetSymbol: string;
  spySymbol: string;
  /** Most-voted player (null = nobody voted). */
  accusedId: string | null;
  caught: boolean;
  /** Spy disconnected mid-round. */
  fled: boolean;
  /** Accusation was a tie, broken randomly. */
  tie: boolean;
  /** Full tally: voterId → votedForId. */
  votes: Record<string, string>;
  /** Points awarded this round. */
  awarded: Record<string, number>;
};

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function createSpySignalMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const participantIds = new Set(players.map((p) => p.playerId));
  const connected = new Set(players.map((p) => p.playerId));
  const points: Record<string, number> = {};
  for (const p of players) points[p.playerId] = 0;

  const state = {
    phase: "peek" as Phase,
    round: 1, // 1-based
    phaseEndsAt: 0,
    candidates: [] as string[],
    targetSymbol: "",
    spySymbol: "",
    spyId: null as string | null,
    votes: new Map<string, string>(),
    reveal: null as Reveal | null,
    prevSpies: new Set<string>(),
    lastSecretSentAt: 0,
    ended: false,
  };

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  function startRound(round: number, anchor: number) {
    state.round = round;
    state.votes.clear();
    state.reveal = null;
    state.lastSecretSentAt = 0;

    // 4 candidate symbols, one target, one spy symbol among the other 3.
    const pool = [...SYMBOL_POOL];
    shuffleInPlace(pool);
    state.candidates = pool.slice(0, 4);
    state.targetSymbol = pickRandom(state.candidates)!;
    state.spySymbol = pickRandom(
      state.candidates.filter((s) => s !== state.targetSymbol),
    )!;

    // Spy: a currently-connected participant, fresh spy when possible.
    const conn = [...connected];
    const fresh = conn.filter((pid) => !state.prevSpies.has(pid));
    state.spyId = pickRandom(fresh.length > 0 ? fresh : conn);
    if (state.spyId) state.prevSpies.add(state.spyId);

    state.phase = "peek";
    state.phaseEndsAt = anchor + PEEK_MS;
  }

  // Round 1 anchors to GO — nothing starts during warm-up.
  startRound(1, ctx.startAt);

  ctx.broadcast({
    type: "welcome",
    deadlineAt: ctx.deadlineAt,
    startAt: ctx.startAt,
    totalRounds: TOTAL_ROUNDS,
    phaseDurations: {
      peek: PEEK_MS,
      discuss: DISCUSS_MS,
      vote: VOTE_MS,
      reveal: REVEAL_MS,
    },
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  /** Secrets go via sendTo ONLY — never in a broadcast before reveal.
   *  sendTo is not replayed on reconnect, so re-send every ~500ms during
   *  peek; the client applies them idempotently (keyed by round). */
  function sendSecrets() {
    for (const pid of connected) {
      const symbol = pid === state.spyId ? state.spySymbol : state.targetSymbol;
      ctx.sendTo(pid, { type: "secret", round: state.round, symbol });
    }
    state.lastSecretSentAt = Date.now();
  }

  function broadcastState() {
    // SECRECY: no spyId / target / spy symbol here until reveal — this
    // reaches spectators too. Candidates + timing only.
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      round: state.round,
      totalRounds: TOTAL_ROUNDS,
      candidates: state.candidates,
      phaseEndsAt: state.phaseEndsAt,
      deadlineAt: ctx.deadlineAt,
      points,
      votedIds: [...state.votes.keys()],
      connected: [...connected],
      reveal: state.phase === "reveal" || state.phase === "ended" ? state.reveal : null,
    });
  }

  function resolveVotes() {
    const votesObj: Record<string, string> = {};
    for (const [voter, target] of state.votes) votesObj[voter] = target;

    // Tally. No votes at all = everyone abstained = spy walks.
    const counts = new Map<string, number>();
    for (const target of state.votes.values()) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    let accusedId: string | null = null;
    let tie = false;
    if (counts.size > 0) {
      const max = Math.max(...counts.values());
      const top = [...counts.entries()]
        .filter(([, n]) => n === max)
        .map(([pid]) => pid);
      tie = top.length > 1;
      accusedId = pickRandom(top);
    }

    const caught = accusedId !== null && accusedId === state.spyId;
    const awarded: Record<string, number> = {};
    if (caught) {
      // Everyone who voted for the spy gets +3; spy gets 0.
      for (const [voter, target] of state.votes) {
        if (target === state.spyId && voter !== state.spyId) {
          awarded[voter] = 3;
          points[voter] = (points[voter] ?? 0) + 3;
        }
      }
    } else if (state.spyId) {
      awarded[state.spyId] = 6;
      points[state.spyId] = (points[state.spyId] ?? 0) + 6;
    }

    state.reveal = {
      spyId: state.spyId ?? "",
      spyNickname: nickOf(state.spyId),
      targetSymbol: state.targetSymbol,
      spySymbol: state.spySymbol,
      accusedId,
      caught,
      fled: false,
      tie,
      votes: votesObj,
      awarded,
    };
    state.phase = "reveal";
  }

  /** Spy disconnected mid-round: end the round immediately, +1 everyone else. */
  function spyFled() {
    const awarded: Record<string, number> = {};
    for (const pid of connected) {
      if (pid === state.spyId) continue;
      awarded[pid] = 1;
      points[pid] = (points[pid] ?? 0) + 1;
    }
    state.reveal = {
      spyId: state.spyId ?? "",
      spyNickname: nickOf(state.spyId),
      targetSymbol: state.targetSymbol,
      spySymbol: state.spySymbol,
      accusedId: null,
      caught: false,
      fled: true,
      tie: false,
      votes: {},
      awarded,
    };
    state.phase = "reveal";
    state.phaseEndsAt = Date.now() + REVEAL_MS;
  }

  /** Total points desc; equal points share a rank (grouped-rank loop). */
  function computePlacements(): {
    placements: Record<string, number>;
    topIds: string[];
  } {
    const ids = players.map((p) => p.playerId);
    ids.sort((a, b) => (points[b] ?? 0) - (points[a] ?? 0));
    const out: Record<string, number> = {};
    let i = 0;
    let rank = 1;
    while (i < ids.length) {
      let j = i;
      while (j < ids.length && (points[ids[j]] ?? 0) === (points[ids[i]] ?? 0)) j++;
      for (let g = i; g < j; g++) out[ids[g]] = rank;
      rank += j - i;
      i = j;
    }
    const topIds = ids.filter((id) => out[id] === 1);
    return { placements: out, topIds };
  }

  function endWith(summaryPrefix: string) {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const { placements, topIds } = computePlacements();
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const summary = winnerId
      ? `${summaryPrefix}${nickOf(winnerId)} wins with ${points[winnerId] ?? 0} pts`
      : `${summaryPrefix}it's a tie`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, scores: { ...points }, summary });
  }

  function checkEnoughPlayers(): boolean {
    if (state.ended) return false;
    let count = 0;
    for (const pid of connected) if (participantIds.has(pid)) count++;
    if (count < 3) {
      endWith("not enough players · ");
      return false;
    }
    return true;
  }

  function advanceAfterReveal() {
    if (state.round >= TOTAL_ROUNDS) {
      endWith("");
      return;
    }
    startRound(state.round + 1, Date.now());
  }

  return {
    tick() {
      if (state.ended) return;
      const now = Date.now();
      if (now >= ctx.deadlineAt) {
        endWith("time's up · ");
        return;
      }
      if (now < ctx.startAt) {
        // Warm-up: keep broadcasting the frozen peek scene; nothing starts.
        broadcastState();
        return;
      }
      if (!checkEnoughPlayers()) return;

      if (state.phase === "peek" && now - state.lastSecretSentAt >= SECRET_RESEND_MS) {
        sendSecrets();
      }

      if (now >= state.phaseEndsAt) {
        if (state.phase === "peek") {
          state.phase = "discuss";
          state.phaseEndsAt = state.phaseEndsAt + DISCUSS_MS;
        } else if (state.phase === "discuss") {
          state.phase = "vote";
          state.phaseEndsAt = state.phaseEndsAt + VOTE_MS;
        } else if (state.phase === "vote") {
          resolveVotes();
          state.phaseEndsAt = state.phaseEndsAt + REVEAL_MS;
        } else if (state.phase === "reveal") {
          advanceAfterReveal();
          if (state.ended) return;
        }
      }
      broadcastState();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (!participantIds.has(playerId)) return;
      if (!connected.has(playerId)) return;
      if (msg.type !== "vote") return;
      if (state.phase !== "vote") return;
      const targetId = msg.targetId;
      if (typeof targetId !== "string") return;
      if (targetId === playerId) return; // no self-votes
      if (!participantIds.has(targetId)) return;
      if (!connected.has(targetId)) return;
      // Changeable until phase end.
      state.votes.set(playerId, targetId);
    },

    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!connected.has(playerId)) return;
      connected.delete(playerId);
      state.votes.delete(playerId);
      // Drop votes aimed at the leaver (they can't be accused anymore).
      for (const [voter, target] of [...state.votes]) {
        if (target === playerId) state.votes.delete(voter);
      }
      const roundLive =
        state.phase === "peek" ||
        state.phase === "discuss" ||
        state.phase === "vote";
      if (roundLive && playerId === state.spyId) {
        if (Date.now() < ctx.startAt) {
          // Warm-up: no secrets were sent yet — just re-deal round 1 with a
          // fresh spy instead of a hollow "spy fled" reveal.
          state.prevSpies.delete(playerId);
          startRound(state.round, ctx.startAt);
        } else {
          spyFled();
        }
      }
      checkEnoughPlayers();
    },

    cleanup() {},
  };
}

const SpySignalDefinition: MiniGameDefinition = {
  id: "spy-signal",
  displayName: "Spy Signal",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 3,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: SS_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createSpySignalMatch,
};

registerMiniGame(SpySignalDefinition);

export default SpySignalDefinition;
