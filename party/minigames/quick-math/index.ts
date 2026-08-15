// Quick Math — last-man-standing FFA, 8 rounds of arithmetic. Each round the
// server generates a problem + 4 choices; everyone answers via big buttons
// (8s limit, first tap locks in). Scoring by server-side answer ORDER:
// first correct +3, every other correct +1, wrong/none 0. Highest total
// after 8 rounds wins; ties share a rank (grouped-rank loop).
//
// Anti-cheat: the correct choice index is NOT broadcast during the question
// phase — it only goes on the wire once the reveal phase starts.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const QM_ROUNDS = 8;
const QUESTION_MS = 8_000;
const REVEAL_MS = 2_500;
/** 8 × (8s + 2.5s) = 84s max; safety net just above. */
const QM_MATCH_TIMEOUT_MS = 95_000;

const FIRST_CORRECT_POINTS = 3;
const OTHER_CORRECT_POINTS = 1;

type Phase = "question" | "reveal" | "ended";

type Problem = {
  text: string;
  choices: number[];
  correctIndex: number;
};

type State = {
  phase: Phase;
  round: number; // 1-based
  problem: Problem;
  /** Answers in arrival order — order decides who was "first correct". */
  answerOrder: { playerId: string; choice: number }[];
  answeredBy: Set<string>;
  /** Points earned in the round just scored (filled at reveal). */
  roundPoints: Record<string, number>;
  firstCorrectId: string | null;
  phaseEndsAt: number;
  totals: Map<string, number>;
  left: Set<string>;
  /** Round 1 is regenerated at GO so nobody solves it during warm-up. */
  started: boolean;
  ended: boolean;
};

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Difficulty ramp: 1-3 easy add/sub, 4-6 harder add/sub/small mult,
 *  7-8 two-digit mult or three-term. Answers always land in 2..99. */
function generateProblem(round: number): Problem {
  let text = "";
  let answer = 0;
  if (round <= 3) {
    if (Math.random() < 0.5) {
      const a = randInt(2, 49);
      const b = randInt(2, Math.min(50, 99 - a));
      text = `${a} + ${b}`;
      answer = a + b;
    } else {
      const a = randInt(12, 99);
      const b = randInt(2, a - 2);
      text = `${a} − ${b}`;
      answer = a - b;
    }
  } else if (round <= 6) {
    const roll = Math.random();
    if (roll < 0.34) {
      const a = randInt(15, 84);
      const b = randInt(15, 99 - a);
      text = `${a} + ${b}`;
      answer = a + b;
    } else if (roll < 0.67) {
      const a = randInt(30, 99);
      const b = randInt(11, a - 2);
      text = `${a} − ${b}`;
      answer = a - b;
    } else {
      const a = randInt(3, 9);
      const b = randInt(3, Math.min(11, Math.floor(99 / a)));
      text = `${a} × ${b}`;
      answer = a * b;
    }
  } else {
    if (Math.random() < 0.5) {
      const a = randInt(12, 19);
      const b = randInt(3, Math.floor(99 / a));
      text = `${a} × ${b}`;
      answer = a * b;
    } else {
      const a = randInt(10, 50);
      const b = randInt(10, 49);
      const c = randInt(Math.max(2, a + b - 99), a + b - 2);
      text = `${a} + ${b} − ${c}`;
      answer = a + b - c;
    }
  }

  // 3 plausible distractors: correct ±1..10, unique, non-negative. Bounded
  // attempts + deterministic fallback (no unbounded loops).
  const opts = new Set<number>([answer]);
  for (let attempt = 0; attempt < 60 && opts.size < 4; attempt++) {
    const delta = randInt(1, 10) * (Math.random() < 0.5 ? -1 : 1);
    const cand = answer + delta;
    if (cand >= 0) opts.add(cand);
  }
  let fallback = 1;
  while (opts.size < 4) opts.add(answer + 10 + fallback++); // ≤3 iterations
  const choices = [...opts];
  // Shuffle.
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { text, choices, correctIndex: choices.indexOf(answer) };
}

function createQuickMathMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: State = {
    phase: "question",
    round: 1,
    problem: generateProblem(1), // placeholder shown during warm-up
    answerOrder: [],
    answeredBy: new Set(),
    roundPoints: {},
    firstCorrectId: null,
    // Anchored to GO — warm-up never burns question time.
    phaseEndsAt: ctx.startAt + QUESTION_MS,
    totals: new Map(players.map((p) => [p.playerId, 0])),
    left: new Set(),
    started: false,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    rounds: QM_ROUNDS,
    questionMs: QUESTION_MS,
    revealMs: REVEAL_MS,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function totalsObj(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [pid, s] of state.totals) out[pid] = s;
    return out;
  }

  function broadcastState() {
    const msg: { type: string; [k: string]: unknown } = {
      type: "state",
      /** false during warm-up — clients keep the answer buttons disarmed. */
      live: state.started,
      phase: state.phase,
      round: state.round,
      rounds: QM_ROUNDS,
      problem: state.problem.text,
      choices: state.problem.choices,
      answeredIds: [...state.answeredBy],
      phaseEndsAt: Math.round(state.phaseEndsAt),
      scores: totalsObj(),
      deadlineAt: ctx.deadlineAt,
    };
    if (state.phase === "reveal") {
      // Only now does the correct answer touch the wire (anti-cheat).
      msg.correctIndex = state.problem.correctIndex;
      const picks: Record<string, number> = {};
      for (const a of state.answerOrder) picks[a.playerId] = a.choice;
      msg.picks = picks;
      msg.roundPoints = state.roundPoints;
      msg.firstCorrectId = state.firstCorrectId;
    }
    ctx.broadcast(msg);
  }

  function scoreRound() {
    state.roundPoints = {};
    state.firstCorrectId = null;
    let firstFound = false;
    for (const a of state.answerOrder) {
      if (a.choice !== state.problem.correctIndex) continue;
      const pts = firstFound ? OTHER_CORRECT_POINTS : FIRST_CORRECT_POINTS;
      if (!firstFound) {
        firstFound = true;
        state.firstCorrectId = a.playerId;
      }
      state.roundPoints[a.playerId] = pts;
      state.totals.set(a.playerId, (state.totals.get(a.playerId) ?? 0) + pts);
    }
    state.phase = "reveal";
    state.phaseEndsAt = Date.now() + REVEAL_MS;
  }

  function startRound(round: number) {
    state.round = round;
    state.problem = generateProblem(round);
    state.answerOrder = [];
    state.answeredBy = new Set();
    state.roundPoints = {};
    state.firstCorrectId = null;
    state.phase = "question";
    state.phaseEndsAt = Math.max(Date.now(), ctx.startAt) + QUESTION_MS;
  }

  function activeCount(): number {
    return players.filter((p) => !state.left.has(p.playerId)).length;
  }

  /** Totals desc; equal totals SHARE a rank (grouped-rank loop, flappy-bird
   *  style). Disconnects rank below everyone still connected (forfeit). */
  function computePlacements(): Record<string, number> {
    type Entry = { playerId: string; score: number };
    const stayed: Entry[] = [];
    const forfeits: Entry[] = [];
    for (const p of players) {
      const e = { playerId: p.playerId, score: state.totals.get(p.playerId) ?? 0 };
      (state.left.has(p.playerId) ? forfeits : stayed).push(e);
    }
    stayed.sort((a, b) => b.score - a.score);
    forfeits.sort((a, b) => b.score - a.score);
    const out: Record<string, number> = {};
    let rank = 1;
    for (const group of [stayed, forfeits]) {
      let i = 0;
      while (i < group.length) {
        let j = i;
        while (j < group.length && group[j].score === group[i].score) j++;
        for (let g = i; g < j; g++) out[group[g].playerId] = rank;
        rank += j - i;
        i = j;
      }
    }
    return out;
  }

  function endGame(reason: "rounds" | "deadline") {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    const topScore = topIds.length
      ? (state.totals.get(topIds[0]) ?? 0)
      : 0;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      scores: totalsObj(),
      summary:
        winnerId && winnerNick
          ? `${reason === "deadline" ? "time's up · " : ""}${winnerNick} wins · ${topScore} pts`
          : `${reason === "deadline" ? "time's up · " : ""}${topIds.length}-way tie at ${topScore} pts`,
    });
  }

  return {
    tick() {
      if (state.ended) return;
      const now = Date.now();
      if (now >= ctx.deadlineAt) {
        endGame("deadline");
        return;
      }
      if (now < ctx.startAt) {
        // Warm-up: clients render the frozen scene; nothing advances yet.
        broadcastState();
        return;
      }
      if (!state.started) {
        // Regenerate round 1 at GO so nobody solved it during warm-up.
        state.started = true;
        startRound(1);
      }
      if (state.phase === "question") {
        const everyoneAnswered =
          activeCount() > 0 &&
          players.every(
            (p) => state.left.has(p.playerId) || state.answeredBy.has(p.playerId),
          );
        if (now >= state.phaseEndsAt || everyoneAnswered) {
          scoreRound();
        }
      } else if (state.phase === "reveal" && now >= state.phaseEndsAt) {
        if (state.round >= QM_ROUNDS) {
          endGame("rounds");
          return;
        }
        startRound(state.round + 1);
      }
      if (state.ended) return;
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (state.phase !== "question") return;
      if (msg.type !== "answer") return;
      if (!players.some((p) => p.playerId === playerId)) return;
      if (state.left.has(playerId)) return;
      if (state.answeredBy.has(playerId)) return; // first tap locks in
      const choice = msg.choice;
      if (typeof choice !== "number" || !Number.isFinite(choice)) return;
      if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
      state.answeredBy.add(playerId);
      state.answerOrder.push({ playerId, choice });
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!players.some((p) => p.playerId === playerId)) return;
      state.left.add(playerId);
      if (activeCount() === 0) endGame("rounds");
    },
    cleanup() {},
  };
}

const QuickMathDefinition: MiniGameDefinition = {
  id: "quick-math",
  displayName: "Quick Math",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: QM_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createQuickMathMatch,
};

registerMiniGame(QuickMathDefinition);

export default QuickMathDefinition;
