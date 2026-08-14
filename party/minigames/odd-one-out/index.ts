// Odd One Out — last-man-standing FFA, 10 rounds. Everyone races on the
// SAME board: a grid of identical colored tiles with exactly one tile a
// slightly different shade. First correct tap wins the round (+3); tapping
// a wrong tile locks you out for the rest of the round. Grid grows 3x3 →
// 6x6 and the shade delta shrinks each round. Highest total after 10
// rounds wins; equal totals share a rank.
//
// Anti-cheat note: the odd tile's index and color MUST be broadcast for
// clients to render the board at all, so a modified client could trivially
// highlight it. Accepted trade-off — this is a friends-lobby game.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const OOO_ROUNDS = 10;
const ROUND_MS = 10_000;
const REVEAL_MS = 1_200;
const OOO_MATCH_TIMEOUT_MS = 150_000;
const WIN_POINTS = 3;

/** Grid side length per round (1-based index into this array). */
const GRID_SIZES = [3, 3, 4, 4, 5, 5, 5, 6, 6, 6];

type Hsl = { h: number; s: number; l: number };

type Board = {
  gridSize: number;
  baseColor: Hsl;
  oddColor: Hsl;
  oddIndex: number;
};

type Phase = "play" | "reveal" | "ended";

type State = {
  phase: Phase;
  round: number; // 1-based
  board: Board;
  lockedOut: Set<string>;
  roundWinner: string | null;
  phaseEndsAt: number;
  totals: Map<string, number>;
  left: Set<string>;
  /** Round 1 is regenerated at GO so nobody scans the board in warm-up. */
  started: boolean;
  ended: boolean;
};

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Lightness delta ramp: round 1 ~35 (very obvious) → round 10 ~8 (subtle). */
function deltaForRound(round: number): number {
  return Math.round(35 - ((round - 1) * 27) / (OOO_ROUNDS - 1));
}

function generateBoard(round: number): Board {
  const gridSize = GRID_SIZES[Math.min(round, OOO_ROUNDS) - 1];
  const h = randInt(0, 359);
  const s = randInt(55, 85);
  const l = randInt(40, 60);
  const delta = deltaForRound(round);
  // Pick the direction that keeps the odd shade in a visible range;
  // random when both fit.
  const canUp = l + delta <= 92;
  const canDown = l - delta >= 8;
  const up = canUp && (!canDown || Math.random() < 0.5);
  const oddL = up ? l + delta : l - delta;
  return {
    gridSize,
    baseColor: { h, s, l },
    oddColor: { h, s, l: oddL },
    oddIndex: randInt(0, gridSize * gridSize - 1),
  };
}

function createOddOneOutMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: State = {
    phase: "play",
    round: 1,
    board: generateBoard(1), // warm-up placeholder, rerolled at GO
    lockedOut: new Set(),
    roundWinner: null,
    // Anchored to GO — warm-up never burns round time.
    phaseEndsAt: ctx.startAt + ROUND_MS,
    totals: new Map(players.map((p) => [p.playerId, 0])),
    left: new Set(),
    started: false,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    rounds: OOO_ROUNDS,
    roundMs: ROUND_MS,
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
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      round: state.round,
      rounds: OOO_ROUNDS,
      gridSize: state.board.gridSize,
      baseColor: state.board.baseColor,
      oddColor: state.board.oddColor,
      oddIndex: state.board.oddIndex,
      lockedOut: [...state.lockedOut],
      roundWinner: state.roundWinner,
      phaseEndsAt: Math.round(state.phaseEndsAt),
      scores: totalsObj(),
      deadlineAt: ctx.deadlineAt,
    });
  }

  function startRound(round: number) {
    state.round = round;
    state.board = generateBoard(round);
    state.lockedOut = new Set();
    state.roundWinner = null;
    state.phase = "play";
    state.phaseEndsAt = Math.max(Date.now(), ctx.startAt) + ROUND_MS;
  }

  function startReveal(winnerId: string | null) {
    state.roundWinner = winnerId;
    if (winnerId) {
      state.totals.set(winnerId, (state.totals.get(winnerId) ?? 0) + WIN_POINTS);
    }
    state.phase = "reveal";
    state.phaseEndsAt = Date.now() + REVEAL_MS;
  }

  function activePlayers(): string[] {
    return players
      .map((p) => p.playerId)
      .filter((pid) => !state.left.has(pid));
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
    const topScore = topIds.length ? (state.totals.get(topIds[0]) ?? 0) : 0;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      scores: totalsObj(),
      summary:
        winnerId && winnerNick
          ? `${reason === "deadline" ? "time's up · " : ""}${winnerNick} has the sharpest eye · ${topScore} pts`
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
        // Reroll round 1 at GO so warm-up scanning is useless.
        state.started = true;
        startRound(1);
      }
      if (state.phase === "play") {
        const active = activePlayers();
        const everyoneLocked =
          active.length > 0 && active.every((pid) => state.lockedOut.has(pid));
        if (now >= state.phaseEndsAt || everyoneLocked) {
          // Nobody found it — reveal with no winner.
          startReveal(null);
        }
      } else if (state.phase === "reveal" && now >= state.phaseEndsAt) {
        if (state.round >= OOO_ROUNDS) {
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
      if (state.phase !== "play") return; // late correct taps score nothing
      if (msg.type !== "tap") return;
      if (!players.some((p) => p.playerId === playerId)) return;
      if (state.left.has(playerId)) return;
      if (state.lockedOut.has(playerId)) return;
      const index = msg.index;
      if (typeof index !== "number" || !Number.isFinite(index)) return;
      const cells = state.board.gridSize * state.board.gridSize;
      if (!Number.isInteger(index) || index < 0 || index >= cells) return;
      if (index === state.board.oddIndex) {
        // First correct tap wins the round.
        startReveal(playerId);
      } else {
        // Wrong tile: locked out for the rest of the round.
        state.lockedOut.add(playerId);
      }
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!players.some((p) => p.playerId === playerId)) return;
      state.left.add(playerId);
      if (activePlayers().length === 0) endGame("rounds");
    },
    cleanup() {},
  };
}

const OddOneOutDefinition: MiniGameDefinition = {
  id: "odd-one-out",
  displayName: "Odd One Out",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: OOO_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createOddOneOutMatch,
};

registerMiniGame(OddOneOutDefinition);

export default OddOneOutDefinition;
