// Flappy Bird — last-man-standing match logic.
//
// All players' birds share the same fixed X column on a portrait field.
// Pipes scroll right→left at a constant speed; everyone faces the same
// pipes. Tap to flap (sets vy = FLAP_VY); gravity does the rest.
//
// Death: hit a pipe / floor / ceiling. Last bird alive wins. If the match
// hits its deadline (5 min), surviving players get coinflip placements
// above all dead players (death order: last-to-die ranked highest among
// the dead).

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const FB_FIELD_W = 500;
export const FB_FIELD_H = 800;
export const FB_BIRD_X = 140;
export const FB_BIRD_RADIUS = 18;
export const FB_PIPE_WIDTH = 80;
export const FB_PIPE_GAP = 220;

const GRAVITY = 1300;
const FLAP_VY = -390;
const MAX_DOWN_VY = 620;
const PIPE_INTERVAL_X = 280;
const PIPE_SCROLL_SPEED = 150;
const INITIAL_PIPE_DELAY_MS = 1500;
const FB_MATCH_TIMEOUT_MS = 3 * 60 * 1000; // 5 min

type Bird = {
  playerId: string;
  y: number;
  vy: number;
  alive: boolean;
  /** Server time of death; 0 = still alive. */
  diedAt: number;
};

type Pipe = {
  id: number;
  x: number;
  gapY: number;
};

type State = {
  birds: Map<string, Bird>;
  pipes: Pipe[];
  pipeIdCounter: number;
  startedAt: number;
  ended: boolean;
};

function createFlappyBirdMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;

  const state: State = {
    birds: new Map(),
    pipes: [],
    pipeIdCounter: 0,
    startedAt: Date.now(),
    ended: false,
  };
  for (const p of players) {
    state.birds.set(p.playerId, {
      playerId: p.playerId,
      y: FB_FIELD_H / 2,
      vy: 0,
      alive: true,
      diedAt: 0,
    });
  }

  // Welcome each participant with the static config.
  for (const p of players) {
    ctx.sendTo(p.playerId, {
      type: "welcome",
      field: { w: FB_FIELD_W, h: FB_FIELD_H },
      bird: { x: FB_BIRD_X, radius: FB_BIRD_RADIUS },
      pipe: { width: FB_PIPE_WIDTH, gap: FB_PIPE_GAP },
      players: players.map((pp) => ({
        playerId: pp.playerId,
        nickname: pp.nickname,
        avatarId: pp.avatarId,
      })),
      deadlineAt: ctx.deadlineAt,
    });
  }

  function broadcastState() {
    const birdsObj: Record<
      string,
      { y: number; vy: number; alive: boolean }
    > = {};
    for (const [pid, b] of state.birds) {
      birdsObj[pid] = { y: b.y, vy: b.vy, alive: b.alive };
    }
    ctx.broadcast({
      type: "state",
      birds: birdsObj,
      pipes: state.pipes.map((p) => ({ id: p.id, x: p.x, gapY: p.gapY })),
      deadlineAt: ctx.deadlineAt,
    });
  }

  function spawnPipe() {
    // Keep gaps reasonably reachable.
    const minGapY = FB_PIPE_GAP / 2 + 60;
    const maxGapY = FB_FIELD_H - FB_PIPE_GAP / 2 - 60;
    const gapY = minGapY + Math.random() * (maxGapY - minGapY);
    state.pipes.push({
      id: state.pipeIdCounter++,
      x: FB_FIELD_W + FB_PIPE_WIDTH / 2,
      gapY,
    });
  }

  function step(dt: number) {
    if (state.ended) return;

    // Pipes — spawn / scroll / despawn.
    if (Date.now() - state.startedAt > INITIAL_PIPE_DELAY_MS) {
      const last = state.pipes[state.pipes.length - 1];
      if (!last || last.x < FB_FIELD_W - PIPE_INTERVAL_X) {
        spawnPipe();
      }
    }
    for (const p of state.pipes) {
      p.x -= PIPE_SCROLL_SPEED * dt;
    }
    state.pipes = state.pipes.filter((p) => p.x + FB_PIPE_WIDTH / 2 > 0);

    // Birds — physics + collision.
    for (const b of state.birds.values()) {
      if (!b.alive) continue;
      b.vy += GRAVITY * dt;
      if (b.vy > MAX_DOWN_VY) b.vy = MAX_DOWN_VY;
      b.y += b.vy * dt;

      // Floor / ceiling.
      if (b.y > FB_FIELD_H - FB_BIRD_RADIUS) {
        b.y = FB_FIELD_H - FB_BIRD_RADIUS;
        kill(b);
        continue;
      }
      if (b.y < FB_BIRD_RADIUS) {
        b.y = FB_BIRD_RADIUS;
        kill(b);
        continue;
      }

      // Pipes (AABB).
      for (const p of state.pipes) {
        const dx = Math.abs(FB_BIRD_X - p.x);
        if (dx < FB_PIPE_WIDTH / 2 + FB_BIRD_RADIUS) {
          const aboveGap = b.y < p.gapY - FB_PIPE_GAP / 2 + FB_BIRD_RADIUS;
          const belowGap = b.y > p.gapY + FB_PIPE_GAP / 2 - FB_BIRD_RADIUS;
          if (aboveGap || belowGap) {
            kill(b);
            break;
          }
        }
      }
    }

    // End conditions: 0 or 1 alive (and the match started with > 1 bird), or
    // solo bird died.
    const totalBirds = state.birds.size;
    const aliveCount = [...state.birds.values()].filter((b) => b.alive).length;
    if (totalBirds > 1 && aliveCount <= 1) {
      endByLastAlive();
      return;
    }
    if (totalBirds === 1 && aliveCount === 0) {
      endByLastAlive();
      return;
    }
  }

  function kill(b: Bird) {
    b.alive = false;
    b.diedAt = Date.now();
  }

  function endByLastAlive() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const winnerId =
      Object.entries(placements).find(([, p]) => p === 1)?.[0] ?? null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: winnerNick ? `${winnerNick} survives` : "everyone died",
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const winnerId =
      Object.entries(placements).find(([, p]) => p === 1)?.[0] ?? null;
    const aliveCount = [...state.birds.values()].filter((b) => b.alive).length;
    const summary =
      aliveCount > 1
        ? `time's up · ${aliveCount} survivors (coinflip)`
        : aliveCount === 1
          ? `time's up · ${players.find((p) => p.playerId === winnerId)?.nickname ?? "?"} survives`
          : `time's up · everyone died`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, summary });
  }

  /**
   * Placements: surviving players get random ranks (coinflip among them) for
   * the top spots, then dead players ordered by reverse death time
   * (last-to-die = best dead rank).
   */
  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const alive = [...state.birds.values()].filter((b) => b.alive);
    const dead = [...state.birds.values()]
      .filter((b) => !b.alive)
      .sort((a, b) => b.diedAt - a.diedAt);
    shuffleInPlace(alive);
    let rank = 1;
    for (const b of alive) out[b.playerId] = rank++;
    for (const b of dead) out[b.playerId] = rank++;
    return out;
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  return {
    tick(dt: number) {
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
      if (msg.type === "flap") {
        const b = state.birds.get(playerId);
        if (!b || !b.alive) return;
        b.vy = FLAP_VY;
      }
    },
    onPlayerLeft(playerId) {
      const b = state.birds.get(playerId);
      if (b && b.alive) {
        b.alive = false;
        b.diedAt = Date.now();
      }
    },
    cleanup() {
      // No external resources.
    },
  };
}

const FlappyBirdDefinition: MiniGameDefinition = {
  id: "flappy-bird",
  displayName: "Flappy Bird",
  gamemode: "last-man-standing",
  // FFA — match takes the full lobby. matchSize is metadata only here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: FB_MATCH_TIMEOUT_MS,
  shuffleWeight: 1,
  createMatch: createFlappyBirdMatch,
};

registerMiniGame(FlappyBirdDefinition);

export default FlappyBirdDefinition;
