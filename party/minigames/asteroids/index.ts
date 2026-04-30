// Portrait Asteroids — match logic for the tournament gamemode.
//
// One match is exactly 2 ships in a wraparound 500×800 field. Each player
// rotates their ship toward a target angle (set by client touch direction),
// thrusts forward when held, and fires bullets that travel for ~1.4s.
// First to 3 hits wins. On match deadline → leader wins, ties → null winner.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const AST_FIELD_W = 500;
export const AST_FIELD_H = 800;
export const AST_SHIP_RADIUS = 14;
export const AST_BULLET_SIZE = 5;

const SHIP_TURN_RATE = 6; // rad/s rotating toward target angle
const THRUST_ACCEL = 240; // px/s²
const MAX_SPEED = 280; // px/s
const PER_SECOND_DAMPING = 0.55;
const BULLET_SPEED = 460;
const BULLET_TTL = 1.4;
const FIRE_COOLDOWN_MS = 280;
const HIT_RADIUS = 22;
const RESPAWN_INVULN_MS = 1500;
const FIRST_TO = 3;
const AST_MATCH_TIMEOUT_MS = 90_000;

type ShipState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  targetAngle: number;
  thrust: boolean;
  lastFireAt: number;
  invulnUntil: number;
};

type BulletState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  ttl: number;
};

type GameState = {
  ships: { p1: ShipState; p2: ShipState };
  bullets: BulletState[];
  scores: { p1: number; p2: number };
  running: boolean;
  ended: boolean;
};

function spawnShip(s: ShipState, x: number, y: number, angle: number): void {
  s.x = x;
  s.y = y;
  s.vx = 0;
  s.vy = 0;
  s.angle = angle;
  s.targetAngle = angle;
  s.thrust = false;
  s.lastFireAt = 0;
  s.invulnUntil = 0;
}

function freshShip(): ShipState {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    targetAngle: 0,
    thrust: false,
    lastFireAt: 0,
    invulnUntil: 0,
  };
}

function freshState(): GameState {
  return {
    ships: { p1: freshShip(), p2: freshShip() },
    bullets: [],
    scores: { p1: 0, p2: 0 },
    running: false,
    ended: false,
  };
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function wrap(v: number, max: number): number {
  return ((v % max) + max) % max;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function createAsteroidsMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) {
    throw new Error("Asteroids requires exactly 2 participants");
  }

  const state = freshState();
  spawnShip(state.ships.p1, AST_FIELD_W / 2, AST_FIELD_H * 0.25, Math.PI);
  spawnShip(state.ships.p2, AST_FIELD_W / 2, AST_FIELD_H * 0.75, 0);

  ctx.sendTo(p1.playerId, welcomeFor("p1"));
  ctx.sendTo(p2.playerId, welcomeFor("p2"));

  function welcomeFor(role: "p1" | "p2") {
    return {
      type: "welcome",
      role,
      field: { w: AST_FIELD_W, h: AST_FIELD_H },
      ship: { radius: AST_SHIP_RADIUS },
      bullet: { size: AST_BULLET_SIZE },
      firstTo: FIRST_TO,
      deadlineAt: ctx.deadlineAt,
      players: {
        p1: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
        p2: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
      },
    };
  }

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      ships: {
        p1: shipPub(state.ships.p1),
        p2: shipPub(state.ships.p2),
      },
      bullets: state.bullets.map((b) => ({
        x: b.x,
        y: b.y,
        ownerId: b.ownerId,
      })),
      scores: state.scores,
      running: state.running,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function shipPub(s: ShipState) {
    return {
      x: s.x,
      y: s.y,
      angle: s.angle,
      thrust: s.thrust,
      invulnUntil: s.invulnUntil,
    };
  }

  state.running = true;
  broadcastState();

  function updateShip(s: ShipState, dt: number) {
    const delta = normalizeAngle(s.targetAngle - s.angle);
    const maxStep = SHIP_TURN_RATE * dt;
    const step = clamp(delta, -maxStep, maxStep);
    s.angle = normalizeAngle(s.angle + step);

    if (s.thrust) {
      s.vx += Math.sin(s.angle) * THRUST_ACCEL * dt;
      s.vy += -Math.cos(s.angle) * THRUST_ACCEL * dt;
    }

    const damp = Math.pow(PER_SECOND_DAMPING, dt);
    s.vx *= damp;
    s.vy *= damp;

    const speed = Math.hypot(s.vx, s.vy);
    if (speed > MAX_SPEED) {
      s.vx *= MAX_SPEED / speed;
      s.vy *= MAX_SPEED / speed;
    }

    s.x = wrap(s.x + s.vx * dt, AST_FIELD_W);
    s.y = wrap(s.y + s.vy * dt, AST_FIELD_H);
  }

  function updateBullets(dt: number) {
    for (let i = state.bullets.length - 1; i >= 0; i--) {
      const b = state.bullets[i];
      b.ttl -= dt;
      if (b.ttl <= 0) {
        state.bullets.splice(i, 1);
        continue;
      }
      b.x = wrap(b.x + b.vx * dt, AST_FIELD_W);
      b.y = wrap(b.y + b.vy * dt, AST_FIELD_H);
    }
  }

  function detectHits() {
    const now = Date.now();
    for (let i = state.bullets.length - 1; i >= 0; i--) {
      const b = state.bullets[i];
      const targetIsP2 = b.ownerId === p1.playerId;
      const target = targetIsP2 ? state.ships.p2 : state.ships.p1;
      if (target.invulnUntil > now) continue;
      const dx = target.x - b.x;
      const dy = target.y - b.y;
      if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) {
        if (targetIsP2) state.scores.p1++;
        else state.scores.p2++;
        if (targetIsP2) {
          spawnShip(target, AST_FIELD_W / 2, AST_FIELD_H * 0.75, 0);
        } else {
          spawnShip(target, AST_FIELD_W / 2, AST_FIELD_H * 0.25, Math.PI);
        }
        target.invulnUntil = now + RESPAWN_INVULN_MS;
        state.bullets.splice(i, 1);
        if (state.scores.p1 >= FIRST_TO || state.scores.p2 >= FIRST_TO) {
          endMatchByScore();
          return;
        }
      }
    }
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
    else winnerId = null;
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
      if (state.running) {
        updateShip(state.ships.p1, dt);
        updateShip(state.ships.p2, dt);
        updateBullets(dt);
        detectHits();
      }
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endMatchByDeadline();
        return;
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      const ship =
        playerId === p1.playerId
          ? state.ships.p1
          : playerId === p2.playerId
            ? state.ships.p2
            : null;
      if (!ship) return;

      if (msg.type === "set-target-angle" && typeof msg.angle === "number") {
        ship.targetAngle = normalizeAngle(msg.angle);
      } else if (msg.type === "set-thrust" && typeof msg.on === "boolean") {
        ship.thrust = msg.on;
      } else if (msg.type === "fire") {
        const now = Date.now();
        if (now - ship.lastFireAt < FIRE_COOLDOWN_MS) return;
        ship.lastFireAt = now;
        const nose = AST_SHIP_RADIUS * 1.2;
        const bx = wrap(ship.x + Math.sin(ship.angle) * nose, AST_FIELD_W);
        const by = wrap(ship.y - Math.cos(ship.angle) * nose, AST_FIELD_H);
        state.bullets.push({
          x: bx,
          y: by,
          vx: Math.sin(ship.angle) * BULLET_SPEED,
          vy: -Math.cos(ship.angle) * BULLET_SPEED,
          ownerId: playerId,
          ttl: BULLET_TTL,
        });
      }
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (playerId !== p1.playerId && playerId !== p2.playerId) return;
      const survivor = playerId === p1.playerId ? p2 : p1;
      state.ended = true;
      state.running = false;
      ctx.endMatch({
        winnerId: survivor.playerId,
        summary: `${survivor.nickname} wins by forfeit`,
      });
    },
    cleanup() {
      // No external resources.
    },
  };
}

const AsteroidsDefinition: MiniGameDefinition = {
  id: "asteroids",
  displayName: "Asteroids",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: AST_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createAsteroidsMatch,
};

registerMiniGame(AsteroidsDefinition);

export default AsteroidsDefinition;
