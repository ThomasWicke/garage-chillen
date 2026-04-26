// Portrait Pong server module. Authoritative physics, 30 Hz tick, first-to-N
// wins the round. Two paddles top/bottom, ball moves vertically.
//
// The mini-game is canonical-orientation: paddle p1 at top, paddle p2 at
// bottom. The client may flip the rendered view per role so each player's own
// paddle is at the bottom of their phone — but the wire format stays canonical.

import { registerMiniGame } from "../registry";
import type {
  MiniGameContext,
  MiniGameDefinition,
  MiniGamePlayer,
  MiniGameSession,
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
  const angle = (Math.random() - 0.5) * 0.6; // ± ~17° from vertical
  state.ball.x = PONG_FIELD_W / 2;
  state.ball.y = PONG_FIELD_H / 2;
  // vy is the dominant component (vertical pong); vx is the side drift.
  state.ball.vx = Math.sin(angle) * INITIAL_BALL_SPEED;
  state.ball.vy = Math.cos(angle) * INITIAL_BALL_SPEED * (towardBottom ? 1 : -1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function createPongSession(ctx: MiniGameContext): MiniGameSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) {
    throw new Error("Pong requires exactly 2 participants");
  }
  const state = freshState();

  // Both participants are actively playing → clicker off.
  ctx.setClickerAvailable(p1.playerId, false);
  ctx.setClickerAvailable(p2.playerId, false);

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      ball: { x: state.ball.x, y: state.ball.y },
      paddles: state.paddles,
      scores: state.scores,
      running: state.running,
    });
  }

  // Send role assignments + static config so clients can size their canvas.
  ctx.sendTo(p1.playerId, {
    type: "welcome",
    role: "p1",
    field: { w: PONG_FIELD_W, h: PONG_FIELD_H },
    paddle: { w: PONG_PADDLE_W, h: PONG_PADDLE_H },
    ball: PONG_BALL_SIZE,
    firstTo: FIRST_TO,
    opponent: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
  });
  ctx.sendTo(p2.playerId, {
    type: "welcome",
    role: "p2",
    field: { w: PONG_FIELD_W, h: PONG_FIELD_H },
    paddle: { w: PONG_PADDLE_W, h: PONG_PADDLE_H },
    ball: PONG_BALL_SIZE,
    firstTo: FIRST_TO,
    opponent: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
  });
  // Spectators are everyone in the lobby who isn't a participant.
  const participantIds = new Set([p1.playerId, p2.playerId]);
  for (const p of ctx.allPlayers) {
    if (participantIds.has(p.playerId)) continue;
    ctx.sendTo(p.playerId, {
      type: "welcome",
      role: "spectator",
      field: { w: PONG_FIELD_W, h: PONG_FIELD_H },
      paddle: { w: PONG_PADDLE_W, h: PONG_PADDLE_H },
      ball: PONG_BALL_SIZE,
      firstTo: FIRST_TO,
    });
  }

  state.running = true;
  resetBall(state, Math.random() < 0.5);
  broadcastState();

  function stepPhysics(dt: number) {
    const b = state.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const half = PONG_BALL_SIZE / 2;

    // Side walls: bounce.
    if (b.x - half < 0) {
      b.x = half;
      b.vx = Math.abs(b.vx);
    } else if (b.x + half > PONG_FIELD_W) {
      b.x = PONG_FIELD_W - half;
      b.vx = -Math.abs(b.vx);
    }

    // Top paddle (p1): ball arriving with vy < 0 near y = PADDLE_Y_TOP.
    if (
      b.vy < 0 &&
      b.y - half < PONG_PADDLE_Y_TOP + PONG_PADDLE_H / 2 &&
      b.y + half > PONG_PADDLE_Y_TOP - PONG_PADDLE_H / 2 &&
      Math.abs(b.x - state.paddles.p1) < PONG_PADDLE_W / 2 + half
    ) {
      bounceVertical(state.paddles.p1, +1);
    }
    // Bottom paddle (p2): ball arriving with vy > 0 near y = PADDLE_Y_BOTTOM.
    if (
      b.vy > 0 &&
      b.y + half > PONG_PADDLE_Y_BOTTOM - PONG_PADDLE_H / 2 &&
      b.y - half < PONG_PADDLE_Y_BOTTOM + PONG_PADDLE_H / 2 &&
      Math.abs(b.x - state.paddles.p2) < PONG_PADDLE_W / 2 + half
    ) {
      bounceVertical(state.paddles.p2, -1);
    }

    // Goals: ball escapes top/bottom.
    if (b.y < 0) {
      // Past top → p2 scored.
      state.scores.p2++;
      if (state.scores.p2 >= FIRST_TO) return endRound();
      resetBall(state, true);
    } else if (b.y > PONG_FIELD_H) {
      state.scores.p1++;
      if (state.scores.p1 >= FIRST_TO) return endRound();
      resetBall(state, false);
    }
  }

  function bounceVertical(paddleX: number, direction: 1 | -1) {
    const b = state.ball;
    const offset = clamp((b.x - paddleX) / (PONG_PADDLE_W / 2), -1, 1);
    const angle = offset * MAX_DEFLECT;
    const speed = Math.hypot(b.vx, b.vy) * SPEED_INCREMENT;
    // direction = +1 means ball was moving up (vy<0), now moves down (vy>0).
    b.vx = Math.sin(angle) * speed;
    b.vy = Math.cos(angle) * speed * direction;
    // Nudge ball out of paddle to prevent re-collision.
    b.y =
      direction === 1
        ? PONG_PADDLE_Y_TOP + PONG_PADDLE_H / 2 + PONG_BALL_SIZE / 2
        : PONG_PADDLE_Y_BOTTOM - PONG_PADDLE_H / 2 - PONG_BALL_SIZE / 2;
  }

  function endRound() {
    if (state.ended) return;
    state.ended = true;
    state.running = false;
    broadcastState();
    const winnerId =
      state.scores.p1 > state.scores.p2 ? p1.playerId : p2.playerId;
    const loserId = winnerId === p1.playerId ? p2.playerId : p1.playerId;
    const winnerScore = Math.max(state.scores.p1, state.scores.p2);
    const loserScore = Math.min(state.scores.p1, state.scores.p2);
    const winnerNick =
      winnerId === p1.playerId ? p1.nickname : p2.nickname;
    ctx.endRound({
      scores: { [winnerId]: winnerScore, [loserId]: loserScore },
      summary: `${winnerNick} wins ${winnerScore}–${loserScore}`,
    });
  }

  return {
    tick(dt: number) {
      if (state.running && !state.ended) stepPhysics(dt);
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
      // If a participant drops, end the round in favor of the remaining one.
      if (state.ended) return;
      if (playerId === p1.playerId || playerId === p2.playerId) {
        const survivor = playerId === p1.playerId ? p2.playerId : p1.playerId;
        const survivorNick =
          survivor === p1.playerId ? p1.nickname : p2.nickname;
        state.ended = true;
        state.running = false;
        ctx.endRound({
          scores: { [survivor]: FIRST_TO },
          summary: `${survivorNick} wins by forfeit`,
        });
      }
    },
    cleanup() {
      // Nothing to release; LobbyServer manages the tick interval.
    },
  };
}

const PongDefinition: MiniGameDefinition = {
  id: "pong",
  displayName: "Pong",
  minPlayers: 2,
  // 1v1 mini-games are wrapped by the bracket layer when the lobby has 3+
  // players. The bracket calls createSession once per match with exactly 2
  // players. maxPlayers describes the lobby capacity, not the per-match cap.
  maxPlayers: 16,
  format: "1v1",
  orientation: "portrait",
  tickHz: 30,
  /** For 1v1 mini-games this is unused — the bracket layer in the lobby
   *  picks the per-match pair. Returning lobbyPlayers as-is keeps the
   *  contract simple for any non-bracket caller. */
  pickParticipants(lobbyPlayers: MiniGamePlayer[]) {
    return lobbyPlayers;
  },
  createSession: createPongSession,
};

registerMiniGame(PongDefinition);

export default PongDefinition;
