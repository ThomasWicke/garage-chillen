// Portrait Pong — match logic for the tournament gamemode.
//
// One match is exactly 2 players, first-to-N wins. On match deadline (set by
// the gamemode) the leader wins; ties → null winner (gamemode picks).
//
// Wire format is canonical (paddle p1 = top, p2 = bottom). The client may
// flip the rendered view per role so each player's own paddle is at the
// bottom of their phone — but the wire stays canonical.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const PONG_FIELD_W = 500;
export const PONG_FIELD_H = 800;
export const PONG_PADDLE_W = 90;
export const PONG_PADDLE_H = 14;
export const PONG_BALL_SIZE = 14;
export const PONG_PADDLE_Y_TOP = 40;
export const PONG_PADDLE_Y_BOTTOM = PONG_FIELD_H - 40;

const INITIAL_BALL_SPEED = 340;
const SPEED_INCREMENT = 1.05;
const MAX_DEFLECT = 0.7; // radians, deviation from vertical at paddle edges
const FIRST_TO = 5;
const PONG_MATCH_TIMEOUT_MS = 120_000;

type ServerState = {
  ball: { x: number; y: number; vx: number; vy: number };
  paddles: { p1: number; p2: number }; // X positions (canonical orientation)
  scores: { p1: number; p2: number };
  running: boolean;
  ended: boolean;
};

function freshState(): ServerState {
  return {
    ball: { x: PONG_FIELD_W / 2, y: PONG_FIELD_H / 2, vx: 0, vy: 0 },
    paddles: { p1: PONG_FIELD_W / 2, p2: PONG_FIELD_W / 2 },
    scores: { p1: 0, p2: 0 },
    running: false,
    ended: false,
  };
}

function resetBall(state: ServerState, towardBottom: boolean): void {
  const angle = (Math.random() - 0.5) * 0.6;
  state.ball.x = PONG_FIELD_W / 2;
  state.ball.y = PONG_FIELD_H / 2;
  state.ball.vx = Math.sin(angle) * INITIAL_BALL_SPEED;
  state.ball.vy = Math.cos(angle) * INITIAL_BALL_SPEED * (towardBottom ? 1 : -1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function createPongMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) {
    throw new Error("Pong requires exactly 2 participants");
  }
  const state = freshState();

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      ball: { x: state.ball.x, y: state.ball.y },
      paddles: state.paddles,
      scores: state.scores,
      running: state.running,
      deadlineAt: ctx.deadlineAt,
    });
  }

  // Send role assignments + static config.
  ctx.sendTo(p1.playerId, {
    type: "welcome",
    role: "p1",
    field: { w: PONG_FIELD_W, h: PONG_FIELD_H },
    paddle: { w: PONG_PADDLE_W, h: PONG_PADDLE_H },
    ball: PONG_BALL_SIZE,
    firstTo: FIRST_TO,
    deadlineAt: ctx.deadlineAt,
    opponent: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
  });
  ctx.sendTo(p2.playerId, {
    type: "welcome",
    role: "p2",
    field: { w: PONG_FIELD_W, h: PONG_FIELD_H },
    paddle: { w: PONG_PADDLE_W, h: PONG_PADDLE_H },
    ball: PONG_BALL_SIZE,
    firstTo: FIRST_TO,
    deadlineAt: ctx.deadlineAt,
    opponent: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
  });

  state.running = true;
  resetBall(state, Math.random() < 0.5);
  broadcastState();

  function stepPhysics(dt: number) {
    const b = state.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const half = PONG_BALL_SIZE / 2;

    if (b.x - half < 0) {
      b.x = half;
      b.vx = Math.abs(b.vx);
    } else if (b.x + half > PONG_FIELD_W) {
      b.x = PONG_FIELD_W - half;
      b.vx = -Math.abs(b.vx);
    }
    if (
      b.vy < 0 &&
      b.y - half < PONG_PADDLE_Y_TOP + PONG_PADDLE_H / 2 &&
      b.y + half > PONG_PADDLE_Y_TOP - PONG_PADDLE_H / 2 &&
      Math.abs(b.x - state.paddles.p1) < PONG_PADDLE_W / 2 + half
    ) {
      bounceVertical(state.paddles.p1, +1);
    }
    if (
      b.vy > 0 &&
      b.y + half > PONG_PADDLE_Y_BOTTOM - PONG_PADDLE_H / 2 &&
      b.y - half < PONG_PADDLE_Y_BOTTOM + PONG_PADDLE_H / 2 &&
      Math.abs(b.x - state.paddles.p2) < PONG_PADDLE_W / 2 + half
    ) {
      bounceVertical(state.paddles.p2, -1);
    }

    if (b.y < 0) {
      state.scores.p2++;
      if (state.scores.p2 >= FIRST_TO) return endMatchByScore();
      resetBall(state, true);
    } else if (b.y > PONG_FIELD_H) {
      state.scores.p1++;
      if (state.scores.p1 >= FIRST_TO) return endMatchByScore();
      resetBall(state, false);
    }
  }

  function bounceVertical(paddleX: number, direction: 1 | -1) {
    const b = state.ball;
    const offset = clamp((b.x - paddleX) / (PONG_PADDLE_W / 2), -1, 1);
    const angle = offset * MAX_DEFLECT;
    const speed = Math.hypot(b.vx, b.vy) * SPEED_INCREMENT;
    b.vx = Math.sin(angle) * speed;
    b.vy = Math.cos(angle) * speed * direction;
    b.y =
      direction === 1
        ? PONG_PADDLE_Y_TOP + PONG_PADDLE_H / 2 + PONG_BALL_SIZE / 2
        : PONG_PADDLE_Y_BOTTOM - PONG_PADDLE_H / 2 - PONG_BALL_SIZE / 2;
  }

  function endMatchByScore() {
    if (state.ended) return;
    state.ended = true;
    state.running = false;
    broadcastState();
    const p1Won = state.scores.p1 > state.scores.p2;
    const winnerId = p1Won ? p1.playerId : p2.playerId;
    const winnerNick = p1Won ? p1.nickname : p2.nickname;
    ctx.endMatch({
      winnerId,
      scores: {
        [p1.playerId]: state.scores.p1,
        [p2.playerId]: state.scores.p2,
      },
      summary: `${winnerNick} wins ${Math.max(state.scores.p1, state.scores.p2)}–${Math.min(state.scores.p1, state.scores.p2)}`,
    });
  }

  function endMatchByDeadline() {
    if (state.ended) return;
    state.ended = true;
    state.running = false;
    broadcastState();
    let winnerId: string | null;
    if (state.scores.p1 > state.scores.p2) winnerId = p1.playerId;
    else if (state.scores.p2 > state.scores.p1) winnerId = p2.playerId;
    else winnerId = null; // draw → gamemode picks
    const summary =
      winnerId === null
        ? `time's up · draw ${state.scores.p1}–${state.scores.p2}`
        : `time's up · ${winnerId === p1.playerId ? p1.nickname : p2.nickname} leads ${Math.max(state.scores.p1, state.scores.p2)}–${Math.min(state.scores.p1, state.scores.p2)}`;
    ctx.endMatch({
      winnerId,
      scores: {
        [p1.playerId]: state.scores.p1,
        [p2.playerId]: state.scores.p2,
      },
      summary,
    });
  }

  return {
    tick(dt: number) {
      if (state.ended) return;
      if (state.running) stepPhysics(dt);
      if (!state.ended && Date.now() >= ctx.deadlineAt) {
        endMatchByDeadline();
        return;
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (msg.type === "paddle" && typeof msg.x === "number") {
        const x = clamp(
          msg.x,
          PONG_PADDLE_W / 2,
          PONG_FIELD_W - PONG_PADDLE_W / 2,
        );
        if (playerId === p1.playerId) state.paddles.p1 = x;
        else if (playerId === p2.playerId) state.paddles.p2 = x;
      }
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (playerId === p1.playerId || playerId === p2.playerId) {
        const survivorId = playerId === p1.playerId ? p2.playerId : p1.playerId;
        const survivorNick = survivorId === p1.playerId ? p1.nickname : p2.nickname;
        state.ended = true;
        state.running = false;
        ctx.endMatch({
          winnerId: survivorId,
          summary: `${survivorNick} wins by forfeit`,
        });
      }
    },
    cleanup() {
      // No external resources.
    },
  };
}

const PongDefinition: MiniGameDefinition = {
  id: "pong",
  displayName: "Pong",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: PONG_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createPongMatch,
};

registerMiniGame(PongDefinition);

export default PongDefinition;
