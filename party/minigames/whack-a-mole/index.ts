// Whack-a-Mole — last-man-standing FFA, score-based. Shared 4×6 grid;
// moles spawn in random cells and despawn after a short lifetime. The first
// player to "whack" a mole gets the point. Highest score after 30s wins;
// ties → coinflip among tied. All players play simultaneously on the same
// field.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const WHACK_FIELD_W = 500;
export const WHACK_FIELD_H = 800;
export const WHACK_COLS = 4;
export const WHACK_ROWS = 6;

const DURATION_MS = 30_000;
const MOLE_LIFETIME_MS = 1100;
const SPAWN_INTERVAL_MS = 550;
const WHACK_MATCH_TIMEOUT_MS = 35_000;

type Mole = {
  id: number;
  col: number;
  row: number;
  spawnedAt: number;
  despawnAt: number;
};

type GameState = {
  moles: Mole[];
  moleIdCounter: number;
  scores: Map<string, number>;
  startedAt: number;
  endsAt: number;
  lastSpawnAt: number;
  ended: boolean;
};

function createWhackAMoleMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: GameState = {
    moles: [],
    moleIdCounter: 0,
    scores: new Map(players.map((p) => [p.playerId, 0])),
    startedAt: Date.now(),
    endsAt: Date.now() + DURATION_MS,
    lastSpawnAt: 0,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    field: { w: WHACK_FIELD_W, h: WHACK_FIELD_H },
    grid: { cols: WHACK_COLS, rows: WHACK_ROWS },
    durationMs: DURATION_MS,
    deadlineAt: ctx.deadlineAt,
    endsAt: state.endsAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    const scoresObj: Record<string, number> = {};
    for (const [pid, s] of state.scores) scoresObj[pid] = s;
    ctx.broadcast({
      type: "state",
      moles: state.moles.map((m) => ({
        id: m.id,
        col: m.col,
        row: m.row,
        despawnAt: m.despawnAt,
      })),
      scores: scoresObj,
      endsAt: state.endsAt,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function spawnMole() {
    // Avoid spawning in a cell that's already occupied.
    const occupied = new Set(state.moles.map((m) => `${m.col},${m.row}`));
    const free: { col: number; row: number }[] = [];
    for (let r = 0; r < WHACK_ROWS; r++) {
      for (let c = 0; c < WHACK_COLS; c++) {
        if (!occupied.has(`${c},${r}`)) free.push({ col: c, row: r });
      }
    }
    if (free.length === 0) return;
    const pick = free[Math.floor(Math.random() * free.length)];
    const now = Date.now();
    state.moles.push({
      id: state.moleIdCounter++,
      col: pick.col,
      row: pick.row,
      spawnedAt: now,
      despawnAt: now + MOLE_LIFETIME_MS,
    });
  }

  function step() {
    const now = Date.now();
    if (now >= state.endsAt) {
      endByDuration();
      return;
    }
    // Despawn expired moles.
    state.moles = state.moles.filter((m) => m.despawnAt > now);
    // Spawn at interval.
    if (now - state.lastSpawnAt >= SPAWN_INTERVAL_MS) {
      state.lastSpawnAt = now;
      spawnMole();
    }
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function computePlacements(): Record<string, number> {
    // Group players by score; within a group, coinflip.
    type Entry = { playerId: string; score: number };
    const entries: Entry[] = [];
    for (const [pid, s] of state.scores) entries.push({ playerId: pid, score: s });
    entries.sort((a, b) => b.score - a.score);
    // Within tied scores, shuffle.
    const out: Record<string, number> = {};
    let rank = 1;
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (j < entries.length && entries[j].score === entries[i].score) j++;
      const tied = entries.slice(i, j);
      shuffleInPlace(tied);
      for (const e of tied) out[e.playerId] = rank++;
      i = j;
    }
    return out;
  }

  function endByDuration() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    const winnerScore = winnerId ? (state.scores.get(winnerId) ?? 0) : 0;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: winnerNick ? `${winnerNick} wins · ${winnerScore} hits` : "no hits",
    });
  }

  function endByDeadline() {
    // Deadline > endsAt + grace, treat same as duration end.
    endByDuration();
  }

  return {
    tick() {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      step();
      if (state.ended) return;
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (msg.type !== "whack") return;
      const moleId = typeof msg.moleId === "number" ? msg.moleId : null;
      if (moleId === null) return;
      const idx = state.moles.findIndex((m) => m.id === moleId);
      if (idx < 0) return;
      // First whack wins — remove the mole and award the point.
      state.moles.splice(idx, 1);
      state.scores.set(playerId, (state.scores.get(playerId) ?? 0) + 1);
    },
    onPlayerLeft() {
      // Player left mid-match: their score stands; they just don't whack any
      // more.
    },
    cleanup() {},
  };
}

const WhackAMoleDefinition: MiniGameDefinition = {
  id: "whack-a-mole",
  displayName: "Whack-a-Mole",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: WHACK_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createWhackAMoleMatch,
};

registerMiniGame(WhackAMoleDefinition);

export default WhackAMoleDefinition;
