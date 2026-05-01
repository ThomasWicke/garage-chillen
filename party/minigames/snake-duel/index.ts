// Snake Duel — tournament 1v1. Two snakes share a portrait grid, eat food
// to grow, and die on hitting any wall, their own body, or the opponent's
// body. Head-on collisions kill both → no winner; gamemode falls back.
//
// Movement is grid-stepped (167ms/step). Inputs are absolute directions;
// reversing onto your own neck is rejected.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const SNAKE_FIELD_W = 500;
export const SNAKE_FIELD_H = 800;
export const SNAKE_GRID_COLS = 20;
export const SNAKE_GRID_ROWS = 32;

const STEP_INTERVAL_MS = 167;
const INITIAL_SNAKE_LEN = 4;
const FOOD_COUNT = 1;
const SNAKE_MATCH_TIMEOUT_MS = 90_000;

type Dir = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

type Snake = {
  cells: Cell[]; // cells[0] = head
  dir: Dir;
  pendingDir: Dir | null;
  alive: boolean;
};

type GameState = {
  p1: Snake;
  p2: Snake;
  food: Cell[];
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

function isOpposite(a: Dir, b: Dir): boolean {
  return (
    (a === "up" && b === "down") ||
    (a === "down" && b === "up") ||
    (a === "left" && b === "right") ||
    (a === "right" && b === "left")
  );
}

function freshSnake(headX: number, headY: number, dir: Dir): Snake {
  const cells: Cell[] = [];
  const v = vecFor(dir);
  for (let i = 0; i < INITIAL_SNAKE_LEN; i++) {
    cells.push({ x: headX - v.x * i, y: headY - v.y * i });
  }
  return { cells, dir, pendingDir: null, alive: true };
}

function createSnakeDuelMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) throw new Error("Snake Duel requires exactly 2 participants");

  const state: GameState = {
    p1: freshSnake(Math.floor(SNAKE_GRID_COLS / 2), 5, "down"),
    p2: freshSnake(Math.floor(SNAKE_GRID_COLS / 2), SNAKE_GRID_ROWS - 6, "up"),
    food: [],
    step: 0,
    lastStepAt: Date.now(),
    ended: false,
  };
  for (let i = 0; i < FOOD_COUNT; i++) spawnFood(state);

  ctx.broadcast({
    type: "welcome",
    field: { w: SNAKE_FIELD_W, h: SNAKE_FIELD_H },
    grid: { cols: SNAKE_GRID_COLS, rows: SNAKE_GRID_ROWS },
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
      snakes: {
        p1: { cells: state.p1.cells, alive: state.p1.alive, dir: state.p1.dir },
        p2: { cells: state.p2.cells, alive: state.p2.alive, dir: state.p2.dir },
      },
      food: state.food,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function spawnFood(s: GameState) {
    // Find an empty cell.
    const occupied = new Set<string>();
    for (const c of s.p1.cells) occupied.add(`${c.x},${c.y}`);
    for (const c of s.p2.cells) occupied.add(`${c.x},${c.y}`);
    for (const c of s.food) occupied.add(`${c.x},${c.y}`);
    const free: Cell[] = [];
    for (let y = 0; y < SNAKE_GRID_ROWS; y++) {
      for (let x = 0; x < SNAKE_GRID_COLS; x++) {
        if (!occupied.has(`${x},${y}`)) free.push({ x, y });
      }
    }
    if (free.length === 0) return;
    s.food.push(free[Math.floor(Math.random() * free.length)]);
  }

  function inBounds(c: Cell): boolean {
    return (
      c.x >= 0 && c.x < SNAKE_GRID_COLS && c.y >= 0 && c.y < SNAKE_GRID_ROWS
    );
  }

  function nextHead(s: Snake): Cell {
    const v = vecFor(s.dir);
    const h = s.cells[0];
    return { x: h.x + v.x, y: h.y + v.y };
  }

  function step() {
    if (state.ended) return;

    // Apply pending direction changes (rejected if reversing on neck).
    for (const s of [state.p1, state.p2]) {
      if (s.pendingDir && !isOpposite(s.pendingDir, s.dir)) {
        s.dir = s.pendingDir;
      }
      s.pendingDir = null;
    }

    const headA = nextHead(state.p1);
    const headB = nextHead(state.p2);

    const aAteFood = state.food.some((f) => f.x === headA.x && f.y === headA.y);
    const bAteFood = state.food.some((f) => f.x === headB.x && f.y === headB.y);

    // "Body after this step" — if not eating, tail will leave so doesn't count.
    const bodyA = aAteFood ? state.p1.cells : state.p1.cells.slice(0, -1);
    const bodyB = bAteFood ? state.p2.cells : state.p2.cells.slice(0, -1);

    const hits = (head: Cell, cells: Cell[]) =>
      cells.some((c) => c.x === head.x && c.y === head.y);

    let aDies = !inBounds(headA) || hits(headA, bodyA) || hits(headA, bodyB);
    let bDies = !inBounds(headB) || hits(headB, bodyA) || hits(headB, bodyB);
    if (headA.x === headB.x && headA.y === headB.y) {
      aDies = true;
      bDies = true;
    }

    if (aDies || bDies) {
      state.p1.alive = !aDies;
      state.p2.alive = !bDies;
      endMatch(aDies, bDies);
      return;
    }

    // Apply moves.
    state.p1.cells.unshift(headA);
    if (aAteFood) state.food = state.food.filter((f) => !(f.x === headA.x && f.y === headA.y));
    else state.p1.cells.pop();
    state.p2.cells.unshift(headB);
    if (bAteFood) state.food = state.food.filter((f) => !(f.x === headB.x && f.y === headB.y));
    else state.p2.cells.pop();

    if (aAteFood || bAteFood) spawnFood(state);
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
    // Leader = longer snake. Tie → null winner (gamemode coinflips).
    const aLen = state.p1.cells.length;
    const bLen = state.p2.cells.length;
    let winnerId: string | null;
    let summary: string;
    if (aLen > bLen) {
      winnerId = p1.playerId;
      summary = `time's up · ${p1.nickname} (${aLen} vs ${bLen})`;
    } else if (bLen > aLen) {
      winnerId = p2.playerId;
      summary = `time's up · ${p2.nickname} (${bLen} vs ${aLen})`;
    } else {
      winnerId = null;
      summary = `time's up · tie at ${aLen}`;
    }
    broadcastState();
    ctx.endMatch({ winnerId, summary });
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
      if (msg.type !== "set-direction") return;
      const dir = msg.dir as Dir;
      if (!["up", "down", "left", "right"].includes(dir)) return;
      const s =
        playerId === p1.playerId
          ? state.p1
          : playerId === p2.playerId
            ? state.p2
            : null;
      if (!s || !s.alive) return;
      s.pendingDir = dir;
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

const SnakeDuelDefinition: MiniGameDefinition = {
  id: "snake-duel",
  displayName: "Snake Duel",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: SNAKE_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createSnakeDuelMatch,
};

registerMiniGame(SnakeDuelDefinition);

export default SnakeDuelDefinition;
