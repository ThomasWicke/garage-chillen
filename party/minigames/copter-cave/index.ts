// Copter Cave — last-man-standing FFA. iCopter classic: all players' copters
// share one auto-scrolling cave on a portrait field, sitting at a fixed X
// column like flappy birds. HOLD to rise, release to fall. The cave is a
// continuous winding tunnel of 60px-wide segments scrolling right→left; the
// gap random-walks vertically and slowly narrows. Fall out of the gap = die.
// Last copter alive wins. On deadline: survivors coinflip placements above
// all dead players.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const CC_FIELD_W = 500;
export const CC_FIELD_H = 800;
export const CC_COPTER_X = 140;
export const CC_COPTER_RADIUS = 14;
export const CC_SEG_W = 60;

const HOLD_ACCEL = 900; // px/s² upward while held
const GRAVITY = 900; // px/s² downward while released
const MAX_VY = 420; // |vy| clamp
const SCROLL_SPEED = 160; // px/s right→left
const GAP_START = 320;
const GAP_SHRINK_PER_SEG = 4;
const GAP_MIN = 190;
const GAP_STEP_MAX = 40; // max random-walk step of gapY per segment
const GAP_EDGE_MARGIN = 30; // keep the gap fully inside the field
const CC_MATCH_TIMEOUT_MS = 120_000;

type Copter = {
  playerId: string;
  y: number;
  vy: number;
  alive: boolean;
  /** Server time of death; 0 = still alive. */
  diedAt: number;
  /** Disconnected mid-match (forfeit). Ranked below natural deaths. */
  left: boolean;
};

type Segment = {
  id: number;
  x: number;
  gapY: number;
  gapH: number;
};

type State = {
  copters: Map<string, Copter>;
  segments: Segment[];
  segCounter: number;
  /** gapY of the most recently generated segment (random-walk cursor). */
  lastGapY: number;
  holds: Map<string, boolean>;
  ended: boolean;
};

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function createCopterCaveMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;

  const state: State = {
    copters: new Map(),
    segments: [],
    segCounter: 0,
    lastGapY: CC_FIELD_H / 2,
    holds: new Map(),
    ended: false,
  };
  for (const p of players) {
    state.copters.set(p.playerId, {
      playerId: p.playerId,
      y: CC_FIELD_H / 2,
      vy: 0,
      alive: true,
      diedAt: 0,
      left: false,
    });
  }

  function gapHFor(segIndex: number): number {
    return Math.max(GAP_MIN, GAP_START - GAP_SHRINK_PER_SEG * segIndex);
  }

  function generateSegment(x: number): Segment {
    const idx = state.segCounter++;
    const gapH = gapHFor(idx);
    // The first screen-width stays straight and centered so the frozen
    // warm-up scene has every copter safely inside the tunnel.
    const straight = idx < Math.ceil(CC_FIELD_W / CC_SEG_W) + 2;
    let gapY: number;
    if (straight) {
      gapY = CC_FIELD_H / 2;
    } else {
      const step = (Math.random() * 2 - 1) * GAP_STEP_MAX;
      gapY = state.lastGapY + step;
    }
    gapY = Math.round(
      clampNum(
        gapY,
        gapH / 2 + GAP_EDGE_MARGIN,
        CC_FIELD_H - gapH / 2 - GAP_EDGE_MARGIN,
      ),
    );
    state.lastGapY = gapY;
    return { id: idx, x, gapY, gapH };
  }

  function topUpSegments() {
    // Keep the field covered up to one segment past the right edge.
    let last = state.segments[state.segments.length - 1];
    let nextX = last ? last.x + CC_SEG_W : 0;
    while (nextX < CC_FIELD_W + CC_SEG_W) {
      state.segments.push(generateSegment(nextX));
      nextX += CC_SEG_W;
    }
  }
  topUpSegments(); // initial fill so warm-up shows the tunnel

  // Single welcome broadcast carrying all static config + roster.
  ctx.broadcast({
    type: "welcome",
    field: { w: CC_FIELD_W, h: CC_FIELD_H },
    copter: { x: CC_COPTER_X, radius: CC_COPTER_RADIUS },
    segWidth: CC_SEG_W,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
    deadlineAt: ctx.deadlineAt,
  });

  function broadcastState() {
    const coptersObj: Record<
      string,
      { y: number; vy: number; alive: boolean }
    > = {};
    for (const [pid, c] of state.copters) {
      coptersObj[pid] = {
        y: Math.round(c.y),
        vy: Math.round(c.vy),
        alive: c.alive,
      };
    }
    ctx.broadcast({
      type: "state",
      copters: coptersObj,
      // Only segments on screen go over the wire.
      segments: state.segments
        .filter((s) => s.x + CC_SEG_W > 0 && s.x < CC_FIELD_W)
        .map((s) => ({
          id: s.id,
          x: Math.round(s.x),
          gapY: s.gapY,
          gapH: s.gapH,
        })),
      deadlineAt: ctx.deadlineAt,
    });
  }

  function step(dt: number) {
    if (state.ended) return;

    // Cave — scroll / despawn / top up.
    for (const s of state.segments) {
      s.x -= SCROLL_SPEED * dt;
    }
    state.segments = state.segments.filter((s) => s.x + CC_SEG_W > -CC_SEG_W);
    topUpSegments();

    // Copters — physics + collision. One shared timestamp so same-tick
    // deaths genuinely share a diedAt (and therefore a rank).
    const now = Date.now();
    for (const c of state.copters.values()) {
      if (!c.alive) continue;
      const held = state.holds.get(c.playerId) === true;
      c.vy += (held ? -HOLD_ACCEL : GRAVITY) * dt;
      c.vy = clampNum(c.vy, -MAX_VY, MAX_VY);
      c.y += c.vy * dt;

      // Field bounds are rock too (safety net — the cave normally kills
      // first).
      if (c.y < CC_COPTER_RADIUS) {
        c.y = CC_COPTER_RADIUS;
        kill(c, now);
        continue;
      }
      if (c.y > CC_FIELD_H - CC_COPTER_RADIUS) {
        c.y = CC_FIELD_H - CC_COPTER_RADIUS;
        kill(c, now);
        continue;
      }

      // Cave ceiling/floor of every segment the copter overlaps: proper
      // circle-vs-rect via closest point on the rock rectangle (same math as
      // the fixed flappy-bird collision).
      const r = CC_COPTER_RADIUS;
      const r2 = r * r;
      for (const s of state.segments) {
        if (s.x > CC_COPTER_X + r || s.x + CC_SEG_W < CC_COPTER_X - r) {
          continue;
        }
        const gapTop = s.gapY - s.gapH / 2;
        const gapBottom = s.gapY + s.gapH / 2;
        // Ceiling rock occupies y ∈ (-∞, gapTop]; floor rock y ∈ [gapBottom, ∞).
        const cx = clampNum(CC_COPTER_X, s.x, s.x + CC_SEG_W);
        const dx = CC_COPTER_X - cx;
        const dyTop = c.y - Math.min(c.y, gapTop);
        const dyBottom = Math.max(c.y, gapBottom) - c.y;
        const hitsTop = dx * dx + dyTop * dyTop < r2 && c.y - r < gapTop;
        const hitsBottom =
          dx * dx + dyBottom * dyBottom < r2 && c.y + r > gapBottom;
        if (hitsTop || hitsBottom) {
          kill(c, now);
          break;
        }
      }
    }

    // End conditions: 0 or 1 alive with >1 copters, or solo copter died.
    const total = state.copters.size;
    const aliveCount = [...state.copters.values()].filter((c) => c.alive).length;
    if (total > 1 && aliveCount <= 1) {
      endByLastAlive();
      return;
    }
    if (total === 1 && aliveCount === 0) {
      endByLastAlive();
      return;
    }
  }

  function kill(c: Copter, at: number) {
    c.alive = false;
    c.diedAt = at;
    state.holds.delete(c.playerId);
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
    const alive = [...state.copters.values()].filter((c) => c.alive);
    const dead = [...state.copters.values()]
      .filter((c) => !c.alive)
      .sort((a, b) => {
        if (a.left !== b.left) return a.left ? 1 : -1;
        return b.diedAt - a.diedAt;
      });
    shuffleInPlace(alive);
    let rank = 1;
    for (const c of alive) out[c.playerId] = rank++;
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
        ? `${winnerNick} flies out alive`
        : topIds.length > 1
          ? "double crash · tie"
          : "everyone crashed",
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
    const aliveCount = [...state.copters.values()].filter((c) => c.alive).length;
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
    tick(dt: number) {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the frozen scene; nothing advances and
        // any stray hold state is cleared so nobody launches pre-armed.
        state.holds.clear();
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
      if (msg.type !== "hold") return;
      if (typeof msg.on !== "boolean") return;
      const c = state.copters.get(playerId);
      if (!c || !c.alive) return; // non-participants & dead: ignored
      state.holds.set(playerId, msg.on);
    },
    onPlayerLeft(playerId) {
      const c = state.copters.get(playerId);
      if (c && c.alive) {
        c.alive = false;
        c.diedAt = Date.now();
        c.left = true;
        state.holds.delete(playerId);
      }
    },
    cleanup() {
      // No external resources.
    },
  };
}

const CopterCaveDefinition: MiniGameDefinition = {
  id: "copter-cave",
  displayName: "Copter Cave",
  gamemode: "last-man-standing",
  // FFA — match takes the full lobby. matchSize is metadata only here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: CC_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createCopterCaveMatch,
};

registerMiniGame(CopterCaveDefinition);

export default CopterCaveDefinition;
