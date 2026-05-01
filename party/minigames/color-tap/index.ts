// Color Tap — last-man-standing FFA. Server flashes one of 4 colors at a
// time; players have 4 colored buttons and must tap the matching color
// within a window. Wrong color or timeout → strike. 3 strikes → out. Speed
// ramps each round.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const COLORS = ["red", "green", "blue", "yellow"] as const;
type Color = (typeof COLORS)[number];

const INITIAL_WINDOW_MS = 1500;
const WINDOW_DECAY = 0.94;
const MIN_WINDOW_MS = 500;
const RESULT_PHASE_MS = 800;
const MAX_STRIKES = 3;
const CT_MATCH_TIMEOUT_MS = 120_000;

type Phase = "signal" | "result";

type PlayerState = {
  strikes: number;
  eliminated: boolean;
  diedAt: number;
  /** Latched response for the current signal round; cleared on next signal. */
  responseColor: Color | null;
};

type GameState = {
  round: number;
  phase: Phase;
  signalColor: Color;
  signalEndsAt: number;
  resultEndsAt: number;
  windowMs: number;
  players: Map<string, PlayerState>;
  ended: boolean;
};

function createColorTapMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: GameState = {
    round: 0,
    phase: "signal",
    signalColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    signalEndsAt: Date.now() + INITIAL_WINDOW_MS,
    resultEndsAt: 0,
    windowMs: INITIAL_WINDOW_MS,
    players: new Map(
      players.map((p) => [
        p.playerId,
        { strikes: 0, eliminated: false, diedAt: 0, responseColor: null },
      ]),
    ),
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    colors: COLORS,
    maxStrikes: MAX_STRIKES,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    const playersObj: Record<
      string,
      { strikes: number; eliminated: boolean; responseColor: Color | null }
    > = {};
    for (const [pid, p] of state.players) {
      playersObj[pid] = {
        strikes: p.strikes,
        eliminated: p.eliminated,
        responseColor: p.responseColor,
      };
    }
    ctx.broadcast({
      type: "state",
      round: state.round,
      phase: state.phase,
      signalColor: state.signalColor,
      signalEndsAt: state.signalEndsAt,
      resultEndsAt: state.resultEndsAt,
      players: playersObj,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function startNextRound() {
    if (state.ended) return;
    state.round++;
    state.windowMs = Math.max(MIN_WINDOW_MS, state.windowMs * WINDOW_DECAY);
    state.signalColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    state.signalEndsAt = Date.now() + state.windowMs;
    state.phase = "signal";
    for (const p of state.players.values()) {
      if (!p.eliminated) p.responseColor = null;
    }
  }

  function evaluateRound() {
    const now = Date.now();
    for (const p of state.players.values()) {
      if (p.eliminated) continue;
      if (p.responseColor !== state.signalColor) {
        p.strikes++;
        if (p.strikes >= MAX_STRIKES) {
          p.eliminated = true;
          p.diedAt = now;
        }
      }
    }
    state.phase = "result";
    state.resultEndsAt = now + RESULT_PHASE_MS;
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const alive: { playerId: string; strikes: number }[] = [];
    const dead: { playerId: string; diedAt: number }[] = [];
    for (const [pid, p] of state.players) {
      if (p.eliminated) dead.push({ playerId: pid, diedAt: p.diedAt });
      else alive.push({ playerId: pid, strikes: p.strikes });
    }
    // Among alive: fewest strikes first, ties → coinflip.
    alive.sort((a, b) => a.strikes - b.strikes);
    const aliveOut: { playerId: string }[] = [];
    let i = 0;
    while (i < alive.length) {
      let j = i;
      while (j < alive.length && alive[j].strikes === alive[i].strikes) j++;
      const tied = alive.slice(i, j).map((e) => ({ playerId: e.playerId }));
      shuffleInPlace(tied);
      aliveOut.push(...tied);
      i = j;
    }
    // Among dead: reverse death time (last-to-die best).
    dead.sort((a, b) => b.diedAt - a.diedAt);

    let rank = 1;
    for (const e of aliveOut) out[e.playerId] = rank++;
    for (const e of dead) out[e.playerId] = rank++;
    return out;
  }

  function endByLastStanding() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: winnerNick ? `${winnerNick} wins` : "everyone struck out",
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
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
      if (state.phase === "signal" && now >= state.signalEndsAt) {
        evaluateRound();
        broadcastState();
        const aliveCount = [...state.players.values()].filter((p) => !p.eliminated).length;
        if (state.players.size > 1 && aliveCount <= 1) {
          // Wait through result then end.
          setTimeout(() => endByLastStanding(), RESULT_PHASE_MS);
          return;
        }
        if (state.players.size === 1 && aliveCount === 0) {
          setTimeout(() => endByLastStanding(), RESULT_PHASE_MS);
          return;
        }
      } else if (state.phase === "result" && now >= state.resultEndsAt) {
        startNextRound();
        broadcastState();
      } else {
        broadcastState();
      }
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (state.phase !== "signal") return;
      if (msg.type !== "tap-color") return;
      const color = msg.color as Color;
      if (!COLORS.includes(color)) return;
      const p = state.players.get(playerId);
      if (!p || p.eliminated) return;
      if (p.responseColor !== null) return; // already tapped this round
      p.responseColor = color;
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

const ColorTapDefinition: MiniGameDefinition = {
  id: "color-tap",
  displayName: "Color Tap",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: CT_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createColorTapMatch,
};

registerMiniGame(ColorTapDefinition);

export default ColorTapDefinition;
