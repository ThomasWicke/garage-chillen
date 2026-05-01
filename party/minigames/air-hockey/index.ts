// Air Hockey — tournament 1v1. Top-down portrait field with goals at top
// (p1's side) and bottom (p2's side). Each player has a circular paddle
// constrained to their own half. Drag to move. First to 5 wins.
//
// Server is authoritative on puck physics; clients send paddle positions.
// Paddle "swing" velocity is tracked from successive position updates and
// added to the puck on contact for satisfying snappy hits.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const AH_FIELD_W = 500;
export const AH_FIELD_H = 800;
export const AH_PADDLE_RADIUS = 32;
export const AH_PUCK_RADIUS = 18;
export const AH_GOAL_HALF_WIDTH = 90;

const INITIAL_PUCK_SPEED = 240;
const PUCK_SPEED_BONUS_ON_HIT = 1.04;
const MAX_PUCK_SPEED = 720;
const PUCK_DAMPING_PER_SEC = 0.7; // mild damping
const FIRST_TO = 5;
const AH_MATCH_TIMEOUT_MS = 120_000;

type Paddle = {
  x: number;
  y: number;
  /** Last position update time (ms) for velocity inference. */
  lastUpdateAt: number;
  vx: number;
  vy: number;
};

type Puck = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type GameState = {
  paddles: { p1: Paddle; p2: Paddle };
  puck: Puck;
  scores: { p1: number; p2: number };
  ended: boolean;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function freshPaddle(slot: "p1" | "p2"): Paddle {
  return {
    x: AH_FIELD_W / 2,
    y: slot === "p1" ? AH_FIELD_H * 0.2 : AH_FIELD_H * 0.8,
    lastUpdateAt: 0,
    vx: 0,
    vy: 0,
  };
}

function resetPuck(state: GameState, towardBottom: boolean) {
  const angle = (Math.random() - 0.5) * 0.6;
  state.puck.x = AH_FIELD_W / 2;
  state.puck.y = AH_FIELD_H / 2;
  state.puck.vx = Math.sin(angle) * INITIAL_PUCK_SPEED;
  state.puck.vy = Math.cos(angle) * INITIAL_PUCK_SPEED * (towardBottom ? 1 : -1);
}

function createAirHockeyMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) throw new Error("Air Hockey requires exactly 2 participants");

  const state: GameState = {
    paddles: { p1: freshPaddle("p1"), p2: freshPaddle("p2") },
    puck: { x: AH_FIELD_W / 2, y: AH_FIELD_H / 2, vx: 0, vy: 0 },
    scores: { p1: 0, p2: 0 },
    ended: false,
  };
  resetPuck(state, Math.random() < 0.5);

  ctx.broadcast({
    type: "welcome",
    field: { w: AH_FIELD_W, h: AH_FIELD_H },
    paddle: { radius: AH_PADDLE_RADIUS },
    puck: { radius: AH_PUCK_RADIUS },
    goal: { halfWidth: AH_GOAL_HALF_WIDTH },
    firstTo: FIRST_TO,
    deadlineAt: ctx.deadlineAt,
    players: {
      p1: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
      p2: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
    },
  });

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      paddles: {
        p1: { x: state.paddles.p1.x, y: state.paddles.p1.y },
        p2: { x: state.paddles.p2.x, y: state.paddles.p2.y },
      },
      puck: { x: state.puck.x, y: state.puck.y },
      scores: state.scores,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function handlePaddlePuckCollision(paddle: Paddle) {
    const dx = state.puck.x - paddle.x;
    const dy = state.puck.y - paddle.y;
    const dist = Math.hypot(dx, dy);
    const minDist = AH_PADDLE_RADIUS + AH_PUCK_RADIUS;
    if (dist > 0.001 && dist < minDist) {
      const nx = dx / dist;
      const ny = dy / dist;
      // Push puck out of paddle.
      const overlap = minDist - dist;
      state.puck.x += nx * overlap;
      state.puck.y += ny * overlap;
      // Reflect puck velocity along normal.
      const vDotN = state.puck.vx * nx + state.puck.vy * ny;
      state.puck.vx -= 2 * vDotN * nx;
      state.puck.vy -= 2 * vDotN * ny;
      // Add paddle's swing velocity (component along normal) for snap.
      const paddleVAlongNormal = paddle.vx * nx + paddle.vy * ny;
      if (paddleVAlongNormal > 0) {
        state.puck.vx += paddleVAlongNormal * nx * 0.8;
        state.puck.vy += paddleVAlongNormal * ny * 0.8;
      }
      // Speed boost.
      const speed = Math.hypot(state.puck.vx, state.puck.vy) * PUCK_SPEED_BONUS_ON_HIT;
      const cappedSpeed = Math.min(speed, MAX_PUCK_SPEED);
      const len = Math.hypot(state.puck.vx, state.puck.vy);
      if (len > 0.001) {
        state.puck.vx = (state.puck.vx / len) * cappedSpeed;
        state.puck.vy = (state.puck.vy / len) * cappedSpeed;
      }
    }
  }

  function step(dt: number) {
    if (state.ended) return;
    // Mild damping (so plays don't get infinite back-and-forth).
    const damp = Math.pow(PUCK_DAMPING_PER_SEC, dt);
    state.puck.vx *= damp;
    state.puck.vy *= damp;
    // Min speed floor — prevent sluggish stalls.
    const minSpeed = 80;
    const speed = Math.hypot(state.puck.vx, state.puck.vy);
    if (speed < minSpeed && speed > 0.001) {
      state.puck.vx *= minSpeed / speed;
      state.puck.vy *= minSpeed / speed;
    }

    state.puck.x += state.puck.vx * dt;
    state.puck.y += state.puck.vy * dt;

    // Side walls.
    const r = AH_PUCK_RADIUS;
    if (state.puck.x - r < 0) {
      state.puck.x = r;
      state.puck.vx = Math.abs(state.puck.vx);
    } else if (state.puck.x + r > AH_FIELD_W) {
      state.puck.x = AH_FIELD_W - r;
      state.puck.vx = -Math.abs(state.puck.vx);
    }

    // Top wall: bounce except in goal range.
    if (state.puck.y - r < 0) {
      const inGoal =
        Math.abs(state.puck.x - AH_FIELD_W / 2) < AH_GOAL_HALF_WIDTH;
      if (inGoal && state.puck.y < -r) {
        state.scores.p2++;
        if (state.scores.p2 >= FIRST_TO) return endByScore();
        resetPuck(state, true);
        return;
      } else if (!inGoal) {
        state.puck.y = r;
        state.puck.vy = Math.abs(state.puck.vy);
      }
    }
    // Bottom wall.
    if (state.puck.y + r > AH_FIELD_H) {
      const inGoal =
        Math.abs(state.puck.x - AH_FIELD_W / 2) < AH_GOAL_HALF_WIDTH;
      if (inGoal && state.puck.y > AH_FIELD_H + r) {
        state.scores.p1++;
        if (state.scores.p1 >= FIRST_TO) return endByScore();
        resetPuck(state, false);
        return;
      } else if (!inGoal) {
        state.puck.y = AH_FIELD_H - r;
        state.puck.vy = -Math.abs(state.puck.vy);
      }
    }

    // Paddle collisions.
    handlePaddlePuckCollision(state.paddles.p1);
    handlePaddlePuckCollision(state.paddles.p2);

    // Decay paddle inferred velocity over time so stale swings don't
    // perpetually boost the puck.
    const now = Date.now();
    for (const p of [state.paddles.p1, state.paddles.p2]) {
      if (now - p.lastUpdateAt > 100) {
        p.vx = 0;
        p.vy = 0;
      }
    }
  }

  function endByScore() {
    if (state.ended) return;
    state.ended = true;
    broadcastState();
    const p1Won = state.scores.p1 > state.scores.p2;
    const winnerId = p1Won ? p1.playerId : p2.playerId;
    const winnerNick = p1Won ? p1.nickname : p2.nickname;
    ctx.endMatch({
      winnerId,
      scores: { [p1.playerId]: state.scores.p1, [p2.playerId]: state.scores.p2 },
      summary: `${winnerNick} wins ${Math.max(state.scores.p1, state.scores.p2)}–${Math.min(state.scores.p1, state.scores.p2)}`,
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    broadcastState();
    let winnerId: string | null;
    if (state.scores.p1 > state.scores.p2) winnerId = p1.playerId;
    else if (state.scores.p2 > state.scores.p1) winnerId = p2.playerId;
    else winnerId = null;
    const summary =
      winnerId === null
        ? `time's up · draw ${state.scores.p1}–${state.scores.p2}`
        : `time's up · ${winnerId === p1.playerId ? p1.nickname : p2.nickname} leads`;
    ctx.endMatch({
      winnerId,
      scores: { [p1.playerId]: state.scores.p1, [p2.playerId]: state.scores.p2 },
      summary,
    });
  }

  return {
    tick(dt) {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      step(dt);
      if (state.ended) return;
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (msg.type !== "move-paddle") return;
      const x = typeof msg.x === "number" ? msg.x : null;
      const y = typeof msg.y === "number" ? msg.y : null;
      if (x === null || y === null) return;
      const p = playerId === p1.playerId ? "p1" : playerId === p2.playerId ? "p2" : null;
      if (!p) return;
      const paddle = state.paddles[p];
      // Constrain to own half.
      const minX = AH_PADDLE_RADIUS;
      const maxX = AH_FIELD_W - AH_PADDLE_RADIUS;
      const minY = p === "p1" ? AH_PADDLE_RADIUS : AH_FIELD_H / 2 + AH_PADDLE_RADIUS;
      const maxY = p === "p1" ? AH_FIELD_H / 2 - AH_PADDLE_RADIUS : AH_FIELD_H - AH_PADDLE_RADIUS;
      const newX = clamp(x, minX, maxX);
      const newY = clamp(y, minY, maxY);
      const now = Date.now();
      if (paddle.lastUpdateAt > 0) {
        const dt = Math.max(0.001, (now - paddle.lastUpdateAt) / 1000);
        paddle.vx = (newX - paddle.x) / dt;
        paddle.vy = (newY - paddle.y) / dt;
      }
      paddle.x = newX;
      paddle.y = newY;
      paddle.lastUpdateAt = now;
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

const AirHockeyDefinition: MiniGameDefinition = {
  id: "air-hockey",
  displayName: "Air Hockey",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: AH_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createAirHockeyMatch,
};

registerMiniGame(AirHockeyDefinition);

export default AirHockeyDefinition;
