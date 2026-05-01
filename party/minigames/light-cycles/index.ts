// Light Cycles — tournament 1v1. Two bikes auto-move on a portrait grid,
// leaving permanent trails. Hitting any trail or wall = die. Last alive
// wins; head-on = both die → null winner.
//
// Inputs are turn-relative-to-direction: "turn-left" / "turn-right". This
// matches the canonical Tron control: tap left half of screen to turn left,
// right half to turn right.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const LC_FIELD_W = 500;
export const LC_FIELD_H = 800;
export const LC_GRID_COLS = 20;
export const LC_GRID_ROWS = 32;

const STEP_INTERVAL_MS = 110;
const LC_MATCH_TIMEOUT_MS = 60_000;

type Dir = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

type Bike = {
  head: Cell;
  dir: Dir;
  pendingTurn: "left" | "right" | null;
  trail: Cell[];
  alive: boolean;
};

type GameState = {
  p1: Bike;
  p2: Bike;
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
  // CW: up → right → down → left → up. CCW reverses.
  const cw: Record<Dir, Dir> = { up: "right", right: "down", down: "left", left: "up" };
  const ccw: Record<Dir, Dir> = { up: "left", left: "down", down: "right", right: "up" };
  return side === "right" ? cw[dir] : ccw[dir];
}

function key(c: Cell): string {
  return `${c.x},${c.y}`;
}

function freshBike(x: number, y: number, dir: Dir): Bike {
  return { head: { x, y }, dir, pendingTurn: null, trail: [{ x, y }], alive: true };
}

function createLightCyclesMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) throw new Error("Light Cycles requires exactly 2 participants");

  const state: GameState = {
    p1: freshBike(Math.floor(LC_GRID_COLS / 2), 4, "down"),
    p2: freshBike(Math.floor(LC_GRID_COLS / 2), LC_GRID_ROWS - 5, "up"),
    occupied: new Set(),
    step: 0,
    lastStepAt: Date.now(),
    ended: false,
  };
  state.occupied.add(key(state.p1.head));
  state.occupied.add(key(state.p2.head));

  ctx.broadcast({
    type: "welcome",
    field: { w: LC_FIELD_W, h: LC_FIELD_H },
    grid: { cols: LC_GRID_COLS, rows: LC_GRID_ROWS },
    deadlineAt: ctx.deadlineAt,
    players: {
      p1: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
      p2: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
    },
  });

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      step: state.step,
      bikes: {
        p1: { head: state.p1.head, dir: state.p1.dir, alive: state.p1.alive, trail: state.p1.trail },
        p2: { head: state.p2.head, dir: state.p2.dir, alive: state.p2.alive, trail: state.p2.trail },
      },
      deadlineAt: ctx.deadlineAt,
    });
  }

  function inBounds(c: Cell): boolean {
    return c.x >= 0 && c.x < LC_GRID_COLS && c.y >= 0 && c.y < LC_GRID_ROWS;
  }

  function step() {
    if (state.ended) return;

    // Apply pending turns.
    for (const b of [state.p1, state.p2]) {
      if (b.pendingTurn) {
        b.dir = turn(b.dir, b.pendingTurn);
        b.pendingTurn = null;
      }
    }

    const next1 = (() => {
      const v = vecFor(state.p1.dir);
      return { x: state.p1.head.x + v.x, y: state.p1.head.y + v.y };
    })();
    const next2 = (() => {
      const v = vecFor(state.p2.dir);
      return { x: state.p2.head.x + v.x, y: state.p2.head.y + v.y };
    })();

    const headOn = next1.x === next2.x && next1.y === next2.y;
    const aDies = !inBounds(next1) || state.occupied.has(key(next1)) || headOn;
    const bDies = !inBounds(next2) || state.occupied.has(key(next2)) || headOn;

    if (aDies || bDies) {
      state.p1.alive = !aDies;
      state.p2.alive = !bDies;
      // If a bike survives, write its move into state.
      if (state.p1.alive) {
        state.p1.head = next1;
        state.p1.trail.push(next1);
        state.occupied.add(key(next1));
      }
      if (state.p2.alive) {
        state.p2.head = next2;
        state.p2.trail.push(next2);
        state.occupied.add(key(next2));
      }
      endMatch(aDies, bDies);
      return;
    }

    state.p1.head = next1;
    state.p1.trail.push(next1);
    state.occupied.add(key(next1));
    state.p2.head = next2;
    state.p2.trail.push(next2);
    state.occupied.add(key(next2));
    state.step++;
  }

  function endMatch(aDied: boolean, bDied: boolean) {
    if (state.ended) return;
    state.ended = true;
    broadcastState();
    let winnerId: string | null;
    let summary: string;
    if (aDied && bDied) {
      winnerId = null;
      summary = "head-on collision · draw";
    } else if (aDied) {
      winnerId = p2.playerId;
      summary = `${p2.nickname} survives`;
    } else {
      winnerId = p1.playerId;
      summary = `${p1.nickname} survives`;
    }
    ctx.endMatch({ winnerId, summary });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    // Both still alive at deadline → null winner (rare).
    broadcastState();
    ctx.endMatch({ winnerId: null, summary: "time's up · draw" });
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
      const b =
        playerId === p1.playerId
          ? state.p1
          : playerId === p2.playerId
            ? state.p2
            : null;
      if (!b || !b.alive) return;
      // Only the latest pending turn applies (overwrite).
      b.pendingTurn = side;
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (playerId !== p1.playerId && playerId !== p2.playerId) return;
      const survivor = playerId === p1.playerId ? p2 : p1;
      state.ended = true;
      ctx.endMatch({
        winnerId: survivor.playerId,
        summary: `${survivor.nickname} wins by forfeit`,
      });
    },
    cleanup() {},
  };
}

const LightCyclesDefinition: MiniGameDefinition = {
  id: "light-cycles",
  displayName: "Light Cycles",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: LC_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createLightCyclesMatch,
};

registerMiniGame(LightCyclesDefinition);

export default LightCyclesDefinition;
