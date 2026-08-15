// Signal Imposter — last-man-standing social deduction, played IN THE ROOM.
// (Module id stays "spy-signal" for registry/wire stability.)
//
// Everyone secretly sees the same crew symbol — except the IMPOSTER, who is
// told they're the imposter and sees NO symbol. The room talks out loud
// (describe the signal without naming it; the imposter bluffs along), then
// the crew votes on who the imposter is while the imposter guesses which
// of the 4 candidate symbols was the signal.
//
// ONE round, tick-driven phase machine:
//   peek (10s)   → per-player secret via sendTo (re-sent ~500ms)
//   discuss (60s)→ phones show nothing revealing; the room talks
//   vote (20s)   → crew: tap an avatar · imposter: tap a symbol
//                  broadcast only WHO has voted, never for whom
//   reveal (12s) → imposter + signal + guess + tally + points
//
// Scoring (all constants below):
//   caught  = imposter has STRICTLY the most crew votes (ties = escaped)
//   crew:     +GROUP_BONUS each if caught, +RIGHT_VOTE if they personally
//             voted the imposter (right vote pays even if the group missed)
//   imposter: +IMPOSTER_ESCAPE if not caught, 0 if caught,
//             +IMPOSTER_GUESS consolation if they guessed the signal
//   imposter disconnects mid-round → crew +1 each, round over.
// Placements: points desc, ties share rank.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const PEEK_MS = 10_000;
const DISCUSS_MS = 60_000;
const VOTE_MS = 20_000;
const REVEAL_MS = 12_000;
const SECRET_RESEND_MS = 500;
const TOTAL_MS = PEEK_MS + DISCUSS_MS + VOTE_MS + REVEAL_MS;
/** peek + discuss + vote + reveal = 102s exactly; safety net just above. */
const SS_MATCH_TIMEOUT_MS = TOTAL_MS + 8_000;

const GROUP_BONUS = 2;
const RIGHT_VOTE = 2;
const IMPOSTER_ESCAPE = 5;
const IMPOSTER_GUESS = 2;
const FLED_BONUS = 1;

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
  imposterId: string;
  imposterNickname: string;
  targetSymbol: string;
  /** Imposter's guess at the signal (null = no guess). */
  imposterGuess: string | null;
  guessRight: boolean;
  /** Most-voted player (null = nobody voted / tie for the top). */
  accusedId: string | null;
  caught: boolean;
  /** Imposter tied for most votes → counts as escaped. */
  tie: boolean;
  /** Imposter disconnected mid-round. */
  fled: boolean;
  /** Crew votes: voterId → votedForId. */
  votes: Record<string, string>;
  /** Points awarded (every participant listed, 0 included). */
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

function createSignalImposterMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const participantIds = new Set(players.map((p) => p.playerId));
  const connected = new Set(players.map((p) => p.playerId));
  const points: Record<string, number> = {};
  for (const p of players) points[p.playerId] = 0;

  const state = {
    phase: "peek" as Phase,
    phaseEndsAt: 0,
    candidates: [] as string[],
    targetSymbol: "",
    imposterId: null as string | null,
    votes: new Map<string, string>(),
    imposterGuess: null as string | null,
    reveal: null as Reveal | null,
    lastSecretSentAt: 0,
    ended: false,
  };

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  function deal(anchor: number) {
    state.votes.clear();
    state.imposterGuess = null;
    state.reveal = null;
    state.lastSecretSentAt = 0;
    const pool = [...SYMBOL_POOL];
    shuffleInPlace(pool);
    state.candidates = pool.slice(0, 4);
    state.targetSymbol = pickRandom(state.candidates)!;
    state.imposterId = pickRandom([...connected]);
    state.phase = "peek";
    state.phaseEndsAt = anchor + PEEK_MS;
  }

  // Anchored to GO — nothing starts during warm-up.
  deal(ctx.startAt);

  ctx.broadcast({
    type: "welcome",
    deadlineAt: ctx.deadlineAt,
    startAt: ctx.startAt,
    phaseDurations: {
      peek: PEEK_MS,
      discuss: DISCUSS_MS,
      vote: VOTE_MS,
      reveal: REVEAL_MS,
    },
    scoring: {
      groupBonus: GROUP_BONUS,
      rightVote: RIGHT_VOTE,
      imposterEscape: IMPOSTER_ESCAPE,
      imposterGuess: IMPOSTER_GUESS,
    },
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  /** Secrets go via sendTo ONLY — never in a broadcast before reveal.
   *  sendTo is not replayed on reconnect, so re-send every ~500ms during
   *  peek; the client applies them idempotently. */
  function sendSecrets() {
    for (const pid of connected) {
      if (pid === state.imposterId) {
        ctx.sendTo(pid, { type: "secret", imposter: true, symbol: null });
      } else {
        ctx.sendTo(pid, { type: "secret", imposter: false, symbol: state.targetSymbol });
      }
    }
    state.lastSecretSentAt = Date.now();
  }

  function broadcastState() {
    // SECRECY: no imposterId / target here until reveal — this reaches
    // spectators too. Candidates + timing only. The imposter counts as
    // "voted" once they've guessed, so the badge row doesn't out them.
    const votedIds = [...state.votes.keys()];
    if (state.imposterGuess !== null && state.imposterId) {
      votedIds.push(state.imposterId);
    }
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      candidates: state.candidates,
      phaseEndsAt: state.phaseEndsAt,
      deadlineAt: ctx.deadlineAt,
      // Real end of the match: phases chain from GO, so it's exact — the
      // client's clock counts to this, not to the safety-net deadline.
      // (An early "imposter fled" reveal ends when its phase does.)
      endsAt:
        state.phase === "reveal" || state.phase === "ended"
          ? state.phaseEndsAt
          : ctx.startAt + TOTAL_MS,
      points,
      votedIds,
      connected: [...connected],
      reveal:
        state.phase === "reveal" || state.phase === "ended" ? state.reveal : null,
    });
  }

  function resolveVotes() {
    const imposter = state.imposterId ?? "";
    const votesObj: Record<string, string> = {};
    for (const [voter, target] of state.votes) votesObj[voter] = target;

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
      if (top.length === 1) {
        accusedId = top[0];
      } else {
        // Tie for the top: no majority → the imposter escapes. Flag it when
        // the imposter was among the tied so the reveal can say so.
        tie = top.includes(imposter);
      }
    }
    const caught = accusedId !== null && accusedId === imposter;
    const guessRight =
      state.imposterGuess !== null && state.imposterGuess === state.targetSymbol;

    const awarded: Record<string, number> = {};
    for (const p of players) awarded[p.playerId] = 0;
    for (const pid of connected) {
      if (pid === imposter) continue;
      let pts = 0;
      if (caught) pts += GROUP_BONUS;
      if (state.votes.get(pid) === imposter) pts += RIGHT_VOTE;
      awarded[pid] = pts;
    }
    let impPts = caught ? 0 : IMPOSTER_ESCAPE;
    if (guessRight) impPts += IMPOSTER_GUESS;
    awarded[imposter] = impPts;
    for (const [pid, pts] of Object.entries(awarded)) {
      points[pid] = (points[pid] ?? 0) + pts;
    }

    state.reveal = {
      imposterId: imposter,
      imposterNickname: nickOf(imposter),
      targetSymbol: state.targetSymbol,
      imposterGuess: state.imposterGuess,
      guessRight,
      accusedId,
      caught,
      tie,
      fled: false,
      votes: votesObj,
      awarded,
    };
    state.phase = "reveal";
  }

  /** Imposter disconnected mid-round: end the round, +1 everyone else. */
  function imposterFled() {
    const awarded: Record<string, number> = {};
    for (const p of players) awarded[p.playerId] = 0;
    for (const pid of connected) {
      if (pid === state.imposterId) continue;
      awarded[pid] = FLED_BONUS;
      points[pid] = (points[pid] ?? 0) + FLED_BONUS;
    }
    state.reveal = {
      imposterId: state.imposterId ?? "",
      imposterNickname: nickOf(state.imposterId),
      targetSymbol: state.targetSymbol,
      imposterGuess: null,
      guessRight: false,
      accusedId: null,
      caught: false,
      tie: false,
      fled: true,
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
          endWith("");
          return;
        }
      }
      broadcastState();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (!participantIds.has(playerId)) return;
      if (!connected.has(playerId)) return;
      if (state.phase !== "vote") return;
      if (playerId === state.imposterId) {
        // Imposter guesses the signal instead of voting.
        if (msg.type !== "guess") return;
        const symbol = msg.symbol;
        if (typeof symbol !== "string") return;
        if (!state.candidates.includes(symbol)) return;
        state.imposterGuess = symbol; // changeable until phase end
        return;
      }
      if (msg.type !== "vote") return;
      const targetId = msg.targetId;
      if (typeof targetId !== "string") return;
      if (targetId === playerId) return; // no self-votes
      if (!participantIds.has(targetId)) return;
      if (!connected.has(targetId)) return;
      state.votes.set(playerId, targetId); // changeable until phase end
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
      if (roundLive && playerId === state.imposterId) {
        if (Date.now() < ctx.startAt) {
          // Warm-up: no secrets sent yet — re-deal with a fresh imposter
          // instead of a hollow "imposter fled" reveal.
          deal(ctx.startAt);
        } else {
          imposterFled();
        }
      }
      checkEnoughPlayers();
    },

    cleanup() {},
  };
}

const SignalImposterDefinition: MiniGameDefinition = {
  id: "spy-signal",
  displayName: "Signal Imposter",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 3,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: SS_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createSignalImposterMatch,
};

registerMiniGame(SignalImposterDefinition);

export default SignalImposterDefinition;
