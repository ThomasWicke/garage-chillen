// Memory Sequence — last-man-standing FFA. 4 colored cells. Each round,
// server flashes a sequence of cells; players watch then tap-repeat. First
// wrong tap = eliminated this round. Sequence grows by 1 each round. Last
// alive wins.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const GRID_SIZE = 4;
const INITIAL_SEQ_LEN = 3;
const FLASH_MS = 600;
const GAP_MS = 200;
const RESULT_HOLD_MS = 1500;
const INPUT_TIMEOUT_PER_STEP_MS = 4_000;
const MS_MATCH_TIMEOUT_MS = 180_000;

type Phase = "show" | "input" | "result" | "ended";

type PlayerState = {
  /** How many sequence steps the player has correctly entered this round. */
  progress: number;
  /** When the player completed the sequence (server time); 0 if not done. */
  completedAt: number;
  eliminated: boolean;
  diedAt: number;
};

type GameState = {
  phase: Phase;
  round: number;
  sequence: number[]; // cell indices 0..GRID_SIZE-1
  /** During "show": which step is currently flashing (-1 = gap). */
  showIdx: number;
  /** Server-time when current step's flash/gap ends. */
  showStepEndsAt: number;
  /** Server-time when input phase deadline hits. */
  inputDeadline: number;
  /** Server-time when result phase ends. */
  resultEndsAt: number;
  /** Per-player progress this round. Reset between rounds. */
  players: Map<string, PlayerState>;
  ended: boolean;
};

function createMemorySequenceMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: GameState = {
    phase: "show",
    round: 0,
    sequence: [],
    showIdx: -1,
    showStepEndsAt: 0,
    inputDeadline: 0,
    resultEndsAt: 0,
    players: new Map(
      players.map((p) => [
        p.playerId,
        { progress: 0, completedAt: 0, eliminated: false, diedAt: 0 },
      ]),
    ),
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    gridSize: GRID_SIZE,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  startNextRound();

  function startNextRound() {
    state.round++;
    const seqLen = INITIAL_SEQ_LEN + (state.round - 1);
    state.sequence = [];
    for (let i = 0; i < seqLen; i++) {
      state.sequence.push(Math.floor(Math.random() * GRID_SIZE));
    }
    state.phase = "show";
    state.showIdx = 0;
    state.showStepEndsAt = Date.now() + FLASH_MS;
    state.inputDeadline = 0;
    state.resultEndsAt = 0;
    for (const p of state.players.values()) {
      if (!p.eliminated) {
        p.progress = 0;
        p.completedAt = 0;
      }
    }
  }

  function broadcastState() {
    const playersObj: Record<
      string,
      { progress: number; eliminated: boolean; completedAt: number }
    > = {};
    for (const [pid, p] of state.players) {
      playersObj[pid] = {
        progress: p.progress,
        eliminated: p.eliminated,
        completedAt: p.completedAt,
      };
    }
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      round: state.round,
      sequenceLength: state.sequence.length,
      // Don't reveal full sequence during "input"; only the cells already shown.
      showIdx: state.showIdx,
      showCell:
        state.phase === "show" && state.showIdx >= 0 && state.showIdx < state.sequence.length
          ? state.sequence[state.showIdx]
          : null,
      showStepEndsAt: state.showStepEndsAt,
      inputDeadline: state.inputDeadline,
      resultEndsAt: state.resultEndsAt,
      players: playersObj,
      deadlineAt: ctx.deadlineAt,
    });
  }

  // Show-phase state machine: showIdx = which cell of the sequence we're
  // currently flashing; inFlash = true when the cell is lit, false during
  // the gap before the next flash.
  let inFlash = true;
  state.showIdx = 0;
  state.showStepEndsAt = Date.now() + FLASH_MS;

  function startInputPhase(now: number) {
    state.phase = "input";
    // Each player has up to (seqLen * INPUT_TIMEOUT_PER_STEP_MS) total — but
    // realistically we want a global deadline. Use sequence length × per-step.
    state.inputDeadline = now + state.sequence.length * INPUT_TIMEOUT_PER_STEP_MS;
  }

  function evaluateInputPhase() {
    // Anyone who didn't finish is eliminated.
    const now = Date.now();
    for (const p of state.players.values()) {
      if (p.eliminated) continue;
      if (p.progress < state.sequence.length) {
        p.eliminated = true;
        p.diedAt = now;
      }
    }
    state.phase = "result";
    state.resultEndsAt = now + RESULT_HOLD_MS;
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const alive: { pid: string; round: number }[] = [];
    const dead: { pid: string; diedAt: number }[] = [];
    for (const [pid, p] of state.players) {
      if (p.eliminated) dead.push({ pid, diedAt: p.diedAt });
      else alive.push({ pid, round: state.round });
    }
    // Among alive: tied (all reached the same round). Coinflip.
    shuffleInPlace(alive);
    dead.sort((a, b) => b.diedAt - a.diedAt);
    let rank = 1;
    for (const e of alive) out[e.pid] = rank++;
    for (const e of dead) out[e.pid] = rank++;
    return out;
  }

  function endByLastAlive() {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: winnerNick ? `${winnerNick} remembers best` : "no winner",
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: "time's up",
    });
  }

  return {
    tick() {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      const now = Date.now();
      if (state.phase === "show" && now >= state.showStepEndsAt) {
        if (inFlash) {
          // Was flashing → start gap.
          state.showStepEndsAt = now + GAP_MS;
          inFlash = false;
        } else {
          // Was in gap → next flash, or transition to input.
          state.showIdx++;
          if (state.showIdx >= state.sequence.length) {
            startInputPhase(now);
          } else {
            state.showStepEndsAt = now + FLASH_MS;
            inFlash = true;
          }
        }
        broadcastState();
      } else if (state.phase === "input") {
        // End early if all alive players finished.
        const alive = [...state.players.values()].filter((p) => !p.eliminated);
        const allDone = alive.length > 0 && alive.every((p) => p.progress >= state.sequence.length);
        if (allDone || now >= state.inputDeadline) {
          evaluateInputPhase();
          broadcastState();
          // After eval, if only 1 alive, end match after RESULT_HOLD_MS.
          const aliveCount = [...state.players.values()].filter((p) => !p.eliminated).length;
          if (state.players.size > 1 && aliveCount <= 1) {
            setTimeout(() => endByLastAlive(), RESULT_HOLD_MS);
            return;
          }
          if (state.players.size === 1 && aliveCount === 0) {
            setTimeout(() => endByLastAlive(), RESULT_HOLD_MS);
            return;
          }
        } else {
          // Idle broadcast keeps clients in sync (player progress).
          broadcastState();
        }
      } else if (state.phase === "result" && now >= state.resultEndsAt) {
        startNextRound();
        inFlash = true;
        broadcastState();
      } else {
        broadcastState();
      }
    },
    onMessage(playerId, msg) {
      if (state.phase !== "input") return;
      if (msg.type !== "tap-cell") return;
      const cellIdx = typeof msg.index === "number" ? msg.index : null;
      if (cellIdx === null || cellIdx < 0 || cellIdx >= GRID_SIZE) return;
      const p = state.players.get(playerId);
      if (!p || p.eliminated) return;
      if (p.progress >= state.sequence.length) return;
      const expected = state.sequence[p.progress];
      if (cellIdx === expected) {
        p.progress++;
        if (p.progress >= state.sequence.length) {
          p.completedAt = Date.now();
        }
      } else {
        // Wrong tap → eliminated this round.
        p.eliminated = true;
        p.diedAt = Date.now();
      }
    },
    onPlayerLeft(playerId) {
      const p = state.players.get(playerId);
      if (p && !p.eliminated) {
        p.eliminated = true;
        p.diedAt = Date.now();
      }
    },
    cleanup() {},
  };
}

const MemorySequenceDefinition: MiniGameDefinition = {
  id: "memory-sequence",
  displayName: "Memory Sequence",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: MS_MATCH_TIMEOUT_MS,
  shuffleWeight: 1,
  createMatch: createMemorySequenceMatch,
};

registerMiniGame(MemorySequenceDefinition);

export default MemorySequenceDefinition;
