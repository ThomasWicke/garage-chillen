// Meteor Dodge — last-man-standing FFA. FallDown-era dodger: every player
// is a circle on the ground line, moving horizontally only. Meteors rain
// from the top with accelerating spawn rate and speed; touch one and you're
// out. Last alive wins. On deadline: survivors coinflip placements above all
// dead players.
//
// Movement is target-based: clients send a target x; the server glides the
// avatar toward it at a capped speed (no teleporting — same idea as the
// air-hockey paddle rate limit, expressed as a per-tick glide).

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const MD_FIELD_W = 500;
export const MD_FIELD_H = 800;
export const MD_PLAYER_RADIUS = 16;
export const MD_GROUND_Y = 760;

const MOVE_MIN_X = 16;
const MOVE_MAX_X = 484;
const PLAYER_SPEED = 380; // px/s glide toward target
const SPAWN_INTERVAL_START_MS = 900;
const SPAWN_ACCEL_PER_SEC = 0.97; // spawn rate +3%/s ⇒ interval ×0.97/s
const METEOR_R_MIN = 12;
const METEOR_R_MAX = 26;
const METEOR_VY_MIN = 220;
const METEOR_VY_MAX = 380;
const METEOR_VY_RAMP_PER_SEC = 8;
const MD_MATCH_TIMEOUT_MS = 120_000;

type Dodger = {
  playerId: string;
  x: number;
  targetX: number;
  alive: boolean;
  /** Server time of death; 0 = still alive. */
  diedAt: number;
  /** Disconnected mid-match (forfeit). Ranked below natural deaths. */
  left: boolean;
};

type Meteor = {
  id: number;
  x: number;
  y: number;
  r: number;
  vy: number;
};

type State = {
  dodgers: Map<string, Dodger>;
  meteors: Meteor[];
  meteorIdCounter: number;
  lastSpawnAt: number;
  ended: boolean;
};

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function createMeteorDodgeMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;

  const state: State = {
    dodgers: new Map(),
    meteors: [],
    meteorIdCounter: 0,
    // First meteor lands one interval after GO, not after creation.
    lastSpawnAt: ctx.startAt,
    ended: false,
  };
  // Spread players evenly along the ground line.
  const n = Math.max(players.length, 1);
  for (let i = 0; i < players.length; i++) {
    const x = Math.round(
      MOVE_MIN_X + ((i + 0.5) / n) * (MOVE_MAX_X - MOVE_MIN_X),
    );
    state.dodgers.set(players[i].playerId, {
      playerId: players[i].playerId,
      x,
      targetX: x,
      alive: true,
      diedAt: 0,
      left: false,
    });
  }

  // Single welcome broadcast carrying all static config + roster.
  ctx.broadcast({
    type: "welcome",
    field: { w: MD_FIELD_W, h: MD_FIELD_H },
    player: { radius: MD_PLAYER_RADIUS, groundY: MD_GROUND_Y },
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
    deadlineAt: ctx.deadlineAt,
  });

  function broadcastState() {
    const playersObj: Record<
      string,
      { x: number; y: number; alive: boolean }
    > = {};
    for (const [pid, d] of state.dodgers) {
      playersObj[pid] = { x: Math.round(d.x), y: MD_GROUND_Y, alive: d.alive };
    }
    ctx.broadcast({
      type: "state",
      players: playersObj,
      meteors: state.meteors.map((m) => ({
        id: m.id,
        x: m.x,
        y: Math.round(m.y),
        r: m.r,
      })),
      deadlineAt: ctx.deadlineAt,
    });
  }

  function spawnMeteor(elapsedSec: number) {
    const r = Math.round(
      METEOR_R_MIN + Math.random() * (METEOR_R_MAX - METEOR_R_MIN),
    );
    const vy = Math.round(
      METEOR_VY_MIN +
        Math.random() * (METEOR_VY_MAX - METEOR_VY_MIN) +
        METEOR_VY_RAMP_PER_SEC * elapsedSec,
    );
    state.meteors.push({
      id: state.meteorIdCounter++,
      x: Math.round(r + Math.random() * (MD_FIELD_W - 2 * r)),
      y: -r, // start just above the screen
      r,
      vy,
    });
  }

  function step(dt: number) {
    if (state.ended) return;
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - ctx.startAt) / 1000);

    // Spawning — interval shrinks 3% per second.
    const interval =
      SPAWN_INTERVAL_START_MS * Math.pow(SPAWN_ACCEL_PER_SEC, elapsedSec);
    if (now - state.lastSpawnAt >= interval) {
      state.lastSpawnAt = now;
      spawnMeteor(elapsedSec);
    }

    // Meteors fall; despawn once fully past the bottom.
    for (const m of state.meteors) {
      m.y += m.vy * dt;
    }
    state.meteors = state.meteors.filter((m) => m.y - m.r < MD_FIELD_H + 40);

    // Players glide toward their target x at capped speed (no teleport).
    for (const d of state.dodgers.values()) {
      if (!d.alive) continue;
      const dx = d.targetX - d.x;
      const maxStep = PLAYER_SPEED * dt;
      d.x += clampNum(dx, -maxStep, maxStep);
    }

    // Collision — plain circle-circle distance. Shared timestamp so
    // same-tick deaths genuinely share a diedAt (and therefore a rank).
    for (const d of state.dodgers.values()) {
      if (!d.alive) continue;
      for (const m of state.meteors) {
        const ddx = m.x - d.x;
        const ddy = m.y - MD_GROUND_Y;
        const rr = m.r + MD_PLAYER_RADIUS;
        if (ddx * ddx + ddy * ddy < rr * rr) {
          d.alive = false;
          d.diedAt = now;
          break;
        }
      }
    }

    // End conditions: 0 or 1 alive with >1 players, or solo player died.
    const total = state.dodgers.size;
    const aliveCount = [...state.dodgers.values()].filter((d) => d.alive).length;
    if (total > 1 && aliveCount <= 1) {
      endByLastAlive();
      return;
    }
    if (total === 1 && aliveCount === 0) {
      endByLastAlive();
      return;
    }
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  /**
   * Survivors coinflip on top; dead ranked by reverse death time with
   * same-tick deaths SHARING a rank; forfeits (disconnects) rank below every
   * natural death.
   */
  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const alive = [...state.dodgers.values()].filter((d) => d.alive);
    const dead = [...state.dodgers.values()]
      .filter((d) => !d.alive)
      .sort((a, b) => {
        if (a.left !== b.left) return a.left ? 1 : -1;
        return b.diedAt - a.diedAt;
      });
    shuffleInPlace(alive);
    let rank = 1;
    for (const d of alive) out[d.playerId] = rank++;
    let i = 0;
    while (i < dead.length) {
      let j = i;
      while (
        j < dead.length &&
        dead[j].diedAt === dead[i].diedAt &&
        dead[j].left === dead[i].left
      ) {
        j++;
      }
      for (let g = i; g < j; g++) out[dead[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    return out;
  }

  function endByLastAlive() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: winnerNick
        ? `${winnerNick} dodges them all`
        : topIds.length > 1
          ? "double hit · tie"
          : "everyone got flattened",
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const aliveCount = [...state.dodgers.values()].filter((d) => d.alive).length;
    const summary =
      aliveCount > 1
        ? `time's up · ${aliveCount} survivors (coinflip)`
        : aliveCount === 1
          ? `time's up · ${players.find((p) => p.playerId === winnerId)?.nickname ?? "?"} survives`
          : `time's up · everyone got flattened`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, summary });
  }

  return {
    tick(dt: number) {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the frozen scene; no meteors spawn or
        // move, nobody walks.
        broadcastState();
        return;
      }
      step(dt);
      if (state.ended) return;
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "move") return;
      if (typeof msg.x !== "number" || !Number.isFinite(msg.x)) return;
      const d = state.dodgers.get(playerId);
      if (!d || !d.alive) return; // non-participants & dead: ignored
      // Clamp the target; actual motion is rate-limited in step().
      d.targetX = clampNum(msg.x, MOVE_MIN_X, MOVE_MAX_X);
    },
    onPlayerLeft(playerId) {
      const d = state.dodgers.get(playerId);
      if (d && d.alive) {
        d.alive = false;
        d.diedAt = Date.now();
        d.left = true;
      }
    },
    cleanup() {
      // No external resources.
    },
  };
}

const MeteorDodgeDefinition: MiniGameDefinition = {
  id: "meteor-dodge",
  displayName: "Meteor Dodge",
  gamemode: "last-man-standing",
  // FFA — match takes the full lobby. matchSize is metadata only here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: MD_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createMeteorDodgeMatch,
};

registerMiniGame(MeteorDodgeDefinition);

export default MeteorDodgeDefinition;
