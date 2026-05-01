// Sumo Push — tournament 1v1. Two avatars in a circular ring. Tap-and-drag
// to charge a lunge in the dragged direction; release to fire. Collisions
// transfer momentum (elastic-ish). Pushed off the edge = ringout, +1 to
// opponent. First to 3 ringouts wins.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const SUMO_FIELD_W = 500;
export const SUMO_FIELD_H = 800;
export const SUMO_ARENA_RADIUS = 220;
export const SUMO_AVATAR_RADIUS = 32;

const LUNGE_FORCE = 700; // initial speed on lunge (px/s)
const LUNGE_COOLDOWN_MS = 700;
const PER_SECOND_DAMPING = 0.35; // multiplier per second
const RESPAWN_INVULN_MS = 1500;
const FIRST_TO = 3;
const SUMO_MATCH_TIMEOUT_MS = 90_000;

type Wrestler = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lastLungeAt: number;
  invulnUntil: number;
};

type GameState = {
  p1: Wrestler;
  p2: Wrestler;
  scores: { p1: number; p2: number };
  ended: boolean;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function spawnWrestler(slot: "p1" | "p2"): Wrestler {
  return {
    x: SUMO_FIELD_W / 2,
    y: slot === "p1"
      ? SUMO_FIELD_H / 2 - SUMO_ARENA_RADIUS / 2
      : SUMO_FIELD_H / 2 + SUMO_ARENA_RADIUS / 2,
    vx: 0,
    vy: 0,
    lastLungeAt: 0,
    invulnUntil: 0,
  };
}

function createSumoPushMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) throw new Error("Sumo Push requires exactly 2 participants");

  const state: GameState = {
    p1: spawnWrestler("p1"),
    p2: spawnWrestler("p2"),
    scores: { p1: 0, p2: 0 },
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    field: { w: SUMO_FIELD_W, h: SUMO_FIELD_H },
    arena: { radius: SUMO_ARENA_RADIUS },
    avatar: { radius: SUMO_AVATAR_RADIUS },
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
      wrestlers: {
        p1: pub(state.p1),
        p2: pub(state.p2),
      },
      scores: state.scores,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function pub(w: Wrestler) {
    return { x: w.x, y: w.y, vx: w.vx, vy: w.vy, invulnUntil: w.invulnUntil };
  }

  function step(dt: number) {
    if (state.ended) return;

    // Damping + integration.
    const damp = Math.pow(PER_SECOND_DAMPING, dt);
    for (const w of [state.p1, state.p2]) {
      w.vx *= damp;
      w.vy *= damp;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
    }

    // Wrestler-wrestler collision (circle-circle elastic).
    const dx = state.p2.x - state.p1.x;
    const dy = state.p2.y - state.p1.y;
    const dist = Math.hypot(dx, dy);
    const minDist = SUMO_AVATAR_RADIUS * 2;
    if (dist > 0.001 && dist < minDist) {
      const nx = dx / dist;
      const ny = dy / dist;
      // Push apart so they don't overlap.
      const overlap = minDist - dist;
      state.p1.x -= nx * overlap * 0.5;
      state.p1.y -= ny * overlap * 0.5;
      state.p2.x += nx * overlap * 0.5;
      state.p2.y += ny * overlap * 0.5;
      // Equal-mass elastic collision: swap velocity components along the
      // collision normal.
      const v1n = state.p1.vx * nx + state.p1.vy * ny;
      const v2n = state.p2.vx * nx + state.p2.vy * ny;
      const dv = v2n - v1n;
      // Add a small extra impulse so collisions feel snappy.
      const impulse = dv + 30;
      state.p1.vx += impulse * nx;
      state.p1.vy += impulse * ny;
      state.p2.vx -= impulse * nx;
      state.p2.vy -= impulse * ny;
    }

    // Ring-out check.
    const cx = SUMO_FIELD_W / 2;
    const cy = SUMO_FIELD_H / 2;
    for (const slot of ["p1", "p2"] as const) {
      const w = slot === "p1" ? state.p1 : state.p2;
      const r = Math.hypot(w.x - cx, w.y - cy);
      const now = Date.now();
      if (r > SUMO_ARENA_RADIUS - SUMO_AVATAR_RADIUS / 2 && w.invulnUntil < now) {
        const winner = slot === "p1" ? "p2" : "p1";
        state.scores[winner]++;
        if (state.scores[winner] >= FIRST_TO) {
          endByScore();
          return;
        }
        // Respawn both, brief invuln.
        state.p1 = spawnWrestler("p1");
        state.p2 = spawnWrestler("p2");
        state.p1.invulnUntil = now + RESPAWN_INVULN_MS;
        state.p2.invulnUntil = now + RESPAWN_INVULN_MS;
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
      summary: `${winnerNick} wins ${state.scores[p1Won ? "p1" : "p2"]}–${state.scores[p1Won ? "p2" : "p1"]}`,
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
      if (msg.type !== "lunge") return;
      const dx = typeof msg.dx === "number" ? msg.dx : 0;
      const dy = typeof msg.dy === "number" ? msg.dy : 0;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) return;
      const w =
        playerId === p1.playerId ? state.p1 : playerId === p2.playerId ? state.p2 : null;
      if (!w) return;
      const now = Date.now();
      if (now - w.lastLungeAt < LUNGE_COOLDOWN_MS) return;
      w.lastLungeAt = now;
      // Strength scales with drag length, capped at 1.
      const strength = clamp(len / 80, 0.4, 1);
      w.vx += (dx / len) * LUNGE_FORCE * strength;
      w.vy += (dy / len) * LUNGE_FORCE * strength;
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

const SumoPushDefinition: MiniGameDefinition = {
  id: "sumo-push",
  displayName: "Sumo Push",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: SUMO_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createSumoPushMatch,
};

registerMiniGame(SumoPushDefinition);

export default SumoPushDefinition;
