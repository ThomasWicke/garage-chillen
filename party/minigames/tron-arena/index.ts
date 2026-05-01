// Tron Arena — last-man-standing FFA. Multiple bikes share a portrait grid,
// leaving permanent trails. Hit any trail or wall = die. Last alive wins.
// On match deadline: surviving players coinflip among themselves.
//
// Spawn: bikes are distributed around the perimeter at evenly-spaced
// positions, each facing inward. Up to 16 simultaneous bikes.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
  MiniGamePlayer,
} from "../types";

export const TA_FIELD_W = 500;
export const TA_FIELD_H = 800;
export const TA_GRID_COLS = 22;
export const TA_GRID_ROWS = 36;

const STEP_INTERVAL_MS = 130;
const TA_MATCH_TIMEOUT_MS = 90_000;

type Dir = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

type Bike = {
  playerId: string;
  head: Cell;
  dir: Dir;
  pendingTurn: "left" | "right" | null;
  trail: Cell[];
  alive: boolean;
  diedAt: number;
};

type GameState = {
  bikes: Map<string, Bike>;
  occupied: Set<string>;
  step: number;
  lastStepAt: number;
  ended: boolean;
};

function vecFor(dir: Dir): Cell {
  switch (dir) {
    case "up": return { x: 0, y: -1 };
    case "down": return { x: 0, y: 1 };
    case "left": return { x: -1, y: 0 };
    case "right": return { x: 1, y: 0 };
  }
}

function turn(dir: Dir, side: "left" | "right"): Dir {
  const cw: Record<Dir, Dir> = { up: "right", right: "down", down: "left", left: "up" };
  const ccw: Record<Dir, Dir> = { up: "left", left: "down", down: "right", right: "up" };
  return side === "right" ? cw[dir] : ccw[dir];
}

function key(c: Cell): string {
  return `${c.x},${c.y}`;
}

/**
 * Distribute N bikes around the inside perimeter, each facing inward. For
 * up to 16 players this puts pairs roughly opposite each other so first
 * collisions don't all happen in the same corner.
 */
function spawnPositions(n: number): { x: number; y: number; dir: Dir }[] {
  // Walk evenly along the perimeter.
  const positions: { x: number; y: number; dir: Dir }[] = [];
  const margin = 3;
  const cols = TA_GRID_COLS - 1;
  const rows = TA_GRID_ROWS - 1;
  const perim =
    2 * (cols - 2 * margin) + 2 * (rows - 2 * margin);
  for (let i = 0; i < n; i++) {
    const t = (i * perim) / n;
    let x: number, y: number, dir: Dir;
    let cursor = t;
    if (cursor < cols - 2 * margin) {
      // top edge, moving right
      x = margin + Math.floor(cursor);
      y = margin;
      dir = "down";
    } else if ((cursor -= cols - 2 * margin) < rows - 2 * margin) {
      // right edge, moving down
      x = cols - margin;
      y = margin + Math.floor(cursor);
      dir = "left";
    } else if ((cursor -= rows - 2 * margin) < cols - 2 * margin) {
      // bottom edge, moving left
      x = cols - margin - Math.floor(cursor);
      y = rows - margin;
      dir = "up";
    } else {
      // left edge, moving up
      cursor -= cols - 2 * margin;
      x = margin;
      y = rows - margin - Math.floor(cursor);
      dir = "right";
    }
    positions.push({ x, y, dir });
  }
  return positions;
}

function createTronArenaMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  if (players.length < 2) {
    // Solo allowed — they just play until they crash or timeout.
  }
  const positions = spawnPositions(Math.max(players.length, 1));
  const state: GameState = {
    bikes: new Map(),
    occupied: new Set(),
    step: 0,
    lastStepAt: Date.now(),
    ended: false,
  };
  for (let i = 0; i < players.length; i++) {
    const pos = positions[i];
    const bike: Bike = {
      playerId: players[i].playerId,
      head: { x: pos.x, y: pos.y },
      dir: pos.dir,
      pendingTurn: null,
      trail: [{ x: pos.x, y: pos.y }],
      alive: true,
      diedAt: 0,
    };
    state.bikes.set(players[i].playerId, bike);
    state.occupied.add(key(bike.head));
  }

  ctx.broadcast({
    type: "welcome",
    field: { w: TA_FIELD_W, h: TA_FIELD_H },
    grid: { cols: TA_GRID_COLS, rows: TA_GRID_ROWS },
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    const bikesObj: Record<
      string,
      { head: Cell; dir: Dir; alive: boolean; trail: Cell[] }
    > = {};
    for (const [pid, b] of state.bikes) {
      bikesObj[pid] = { head: b.head, dir: b.dir, alive: b.alive, trail: b.trail };
    }
    ctx.broadcast({
      type: "state",
      step: state.step,
      bikes: bikesObj,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function inBounds(c: Cell): boolean {
    return c.x >= 0 && c.x < TA_GRID_COLS && c.y >= 0 && c.y < TA_GRID_ROWS;
  }

  function step() {
    if (state.ended) return;

    // Apply pending turns.
    for (const b of state.bikes.values()) {
      if (b.alive && b.pendingTurn) {
        b.dir = turn(b.dir, b.pendingTurn);
        b.pendingTurn = null;
      }
    }

    // Compute next heads.
    const nexts = new Map<string, Cell>();
    for (const b of state.bikes.values()) {
      if (!b.alive) continue;
      const v = vecFor(b.dir);
      nexts.set(b.playerId, { x: b.head.x + v.x, y: b.head.y + v.y });
    }

    // Detect head-on collisions: same target cell.
    const targetCount = new Map<string, number>();
    for (const next of nexts.values()) {
      targetCount.set(key(next), (targetCount.get(key(next)) ?? 0) + 1);
    }

    // Determine deaths.
    const dies = new Set<string>();
    for (const [pid, next] of nexts) {
      if (!inBounds(next) || state.occupied.has(key(next))) {
        dies.add(pid);
        continue;
      }
      if ((targetCount.get(key(next)) ?? 0) > 1) {
        dies.add(pid);
      }
    }

    // Apply: survivors move and add to occupied; dead bikes don't extend.
    for (const [pid, next] of nexts) {
      const b = state.bikes.get(pid);
      if (!b) continue;
      if (dies.has(pid)) {
        b.alive = false;
        b.diedAt = Date.now();
      } else {
        b.head = next;
        b.trail.push(next);
        state.occupied.add(key(next));
      }
    }

    // End condition: with N>1 bikes, last alive wins. With N=1 (solo), play
    // until they die.
    const aliveCount = [...state.bikes.values()].filter((b) => b.alive).length;
    if (state.bikes.size > 1 && aliveCount <= 1) {
      endByLastAlive();
      return;
    }
    if (state.bikes.size === 1 && aliveCount === 0) {
      endByLastAlive();
      return;
    }

    state.step++;
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const alive = [...state.bikes.values()].filter((b) => b.alive);
    const dead = [...state.bikes.values()]
      .filter((b) => !b.alive)
      .sort((a, b) => b.diedAt - a.diedAt);
    shuffleInPlace(alive);
    let rank = 1;
    for (const b of alive) out[b.playerId] = rank++;
    for (const b of dead) out[b.playerId] = rank++;
    return out;
  }

  function endByLastAlive() {
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
      summary: winnerNick ? `${winnerNick} survives` : "everyone crashed",
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    const aliveCount = [...state.bikes.values()].filter((b) => b.alive).length;
    const summary =
      aliveCount > 1
        ? `time's up · ${aliveCount} survivors (coinflip)`
        : aliveCount === 1
          ? `time's up · ${players.find((p) => p.playerId === winnerId)?.nickname ?? "?"} survives`
          : `time's up · everyone crashed`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, summary });
  }

  return {
    tick() {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      const now = Date.now();
      if (now - state.lastStepAt >= STEP_INTERVAL_MS) {
        state.lastStepAt = now;
        step();
        if (state.ended) return;
        broadcastState();
      }
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (msg.type !== "turn") return;
      const side = msg.side as "left" | "right";
      if (side !== "left" && side !== "right") return;
      const b = state.bikes.get(playerId);
      if (!b || !b.alive) return;
      b.pendingTurn = side;
    },
    onPlayerLeft(playerId) {
      const b = state.bikes.get(playerId);
      if (b && b.alive) {
        b.alive = false;
        b.diedAt = Date.now();
      }
    },
    cleanup() {},
  };
}

const TronArenaDefinition: MiniGameDefinition = {
  id: "tron-arena",
  displayName: "Tron Arena",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: TA_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createTronArenaMatch,
};

registerMiniGame(TronArenaDefinition);

export default TronArenaDefinition;
// Suppress unused-warning for MiniGamePlayer typing.
export type _ = MiniGamePlayer;
