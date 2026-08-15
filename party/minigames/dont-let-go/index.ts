// Don't Let Go — last-man-standing finger endurance.
//
// Every player keeps a finger pressed on a wandering dot on their OWN screen.
// The dot drifts around the field, accelerating relentlessly until staying
// on it becomes physically impossible. Lose contact for more than a 350ms
// grace window = eliminated. Last finger standing wins.
//
// The server is authoritative for the dot path and eliminations. Clients
// report their contact state as an idempotent set: an edge message on change
// PLUS a re-send of the current state every ~100ms (see addendum rule 4).
// A player with no contact message at all for 1200ms is treated as stale
// (dead client) and eliminated.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const DLG_FIELD_W = 500;
export const DLG_FIELD_H = 800;
/** The dot is a 76px circle in field units. */
export const DLG_DOT_RADIUS = 38;
/** Client counts the finger as "on" within this distance of dot center. */
export const DLG_CONTACT_RADIUS = 70;

const WAYPOINT_MARGIN = 60;
/** Contact may be lost for at most this long before elimination. */
const GRACE_MS = 350;
/** No contact message at all for this long = stale client, eliminated. */
const STALE_MS = 1_200;
/** Dot speed at GO (px/s). The ramp below makes the endgame impossible:
 *  speed(t) = BASE + LINEAR·t + QUAD·t² (t in seconds) —
 *  ~130 px/s at 30s, ~250 at 60s, ~400 at 90s. Nobody survives to 90. */
const BASE_SPEED = 45;
const SPEED_LINEAR_PER_S = 2.2;
const SPEED_QUAD_PER_S2 = 0.02;
const DLG_MATCH_TIMEOUT_MS = 90_000;

type PlayerState = {
  playerId: string;
  alive: boolean;
  /** Server time of death; 0 = still alive. Shared per-tick timestamp so
   *  same-tick deaths share a placement rank. */
  diedAt: number;
  /** Disconnected mid-match (forfeit). Ranked below natural deaths. */
  left: boolean;
  contactOn: boolean;
  /** When contact last flipped OFF (grace window counts from here). */
  contactOffSince: number;
  /** Last time ANY contact message arrived (stale-client safety). */
  lastContactMsgAt: number;
};

type State = {
  players: Map<string, PlayerState>;
  dot: { x: number; y: number };
  waypoint: { x: number; y: number } | null;
  /** One-shot re-anchor of grace/stale timers at GO. */
  liveInit: boolean;
  ended: boolean;
};

function createDontLetGoMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;

  const state: State = {
    players: new Map(),
    // Dot frozen at center until GO.
    dot: { x: DLG_FIELD_W / 2, y: DLG_FIELD_H / 2 },
    waypoint: null,
    liveInit: false,
    ended: false,
  };
  for (const p of players) {
    state.players.set(p.playerId, {
      playerId: p.playerId,
      alive: true,
      diedAt: 0,
      left: false,
      contactOn: false,
      // Anchored to GO: a client that never reports gets the stale timeout
      // measured from startAt, and the grace window starts fresh at GO.
      contactOffSince: ctx.startAt,
      lastContactMsgAt: ctx.startAt,
    });
  }

  ctx.broadcast({
    type: "welcome",
    field: { w: DLG_FIELD_W, h: DLG_FIELD_H },
    dot: { radius: DLG_DOT_RADIUS, contactRadius: DLG_CONTACT_RADIUS },
    graceMs: GRACE_MS,
    startAt: ctx.startAt,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      dot: { x: Math.round(state.dot.x), y: Math.round(state.dot.y) },
      alive: [...state.players.values()]
        .filter((p) => p.alive)
        .map((p) => p.playerId),
      deadlineAt: ctx.deadlineAt,
    });
  }

  function pickWaypoint(): { x: number; y: number } {
    return {
      x: WAYPOINT_MARGIN + Math.random() * (DLG_FIELD_W - 2 * WAYPOINT_MARGIN),
      y: WAYPOINT_MARGIN + Math.random() * (DLG_FIELD_H - 2 * WAYPOINT_MARGIN),
    };
  }

  function moveDot(dt: number, now: number) {
    if (!state.waypoint) state.waypoint = pickWaypoint();
    const t = Math.max(0, now - ctx.startAt) / 1000;
    const speed = BASE_SPEED + SPEED_LINEAR_PER_S * t + SPEED_QUAD_PER_S2 * t * t;
    const dx = state.waypoint.x - state.dot.x;
    const dy = state.waypoint.y - state.dot.y;
    const dist = Math.hypot(dx, dy);
    const step = speed * dt;
    if (dist <= Math.max(step, 1)) {
      state.dot.x = state.waypoint.x;
      state.dot.y = state.waypoint.y;
      state.waypoint = pickWaypoint();
    } else {
      state.dot.x += (dx / dist) * step;
      state.dot.y += (dy / dist) * step;
    }
  }

  function kill(p: PlayerState, at: number) {
    p.alive = false;
    p.diedAt = at;
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  /**
   * Placements: survivors get shuffled top ranks; then natural deaths by
   * reverse death time (same-tick deaths SHARE a rank); forfeits rank below
   * every natural death.
   */
  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const all = [...state.players.values()];
    const alive = all.filter((p) => p.alive);
    const naturals = all
      .filter((p) => !p.alive && !p.left)
      .sort((a, b) => b.diedAt - a.diedAt);
    const forfeits = all
      .filter((p) => !p.alive && p.left)
      .sort((a, b) => b.diedAt - a.diedAt);
    shuffleInPlace(alive);
    let rank = 1;
    for (const p of alive) out[p.playerId] = rank++;
    for (const group of [naturals, forfeits]) {
      let i = 0;
      while (i < group.length) {
        let j = i;
        while (j < group.length && group[j].diedAt === group[i].diedAt) j++;
        for (let g = i; g < j; g++) out[group[g].playerId] = rank;
        rank += j - i;
        i = j;
      }
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
        ? `${winnerNick} never let go`
        : topIds.length > 1
          ? "everyone let go at once · tie"
          : "everyone let go",
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const winnerId =
      Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    const aliveCount = [...state.players.values()].filter((p) => p.alive).length;
    const summary =
      aliveCount > 1
        ? `time's up · ${aliveCount} iron fingers (coinflip)`
        : aliveCount === 1
          ? `time's up · ${players.find((p) => p.playerId === winnerId)?.nickname ?? "?"} held on`
          : "time's up · everyone let go";
    broadcastState();
    ctx.endMatch({ winnerId, placements, summary });
  }

  return {
    tick(dt: number) {
      if (state.ended) return;
      const now = Date.now();
      if (now >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      if (now < ctx.startAt) {
        // Warm-up: dot frozen at center, contact accepted but no
        // eliminations; keep broadcasting so clients render the scene.
        broadcastState();
        return;
      }

      if (!state.liveInit) {
        // GO: the elimination grace + stale windows start fresh so nothing
        // that happened during warm-up can kill anyone at t=+1ms.
        state.liveInit = true;
        for (const p of state.players.values()) {
          p.lastContactMsgAt = Math.max(p.lastContactMsgAt, ctx.startAt);
          if (!p.contactOn) {
            p.contactOffSince = Math.max(p.contactOffSince, ctx.startAt);
          }
        }
      }

      moveDot(dt, now);

      // Eliminations — one shared timestamp so same-tick deaths tie.
      for (const p of state.players.values()) {
        if (!p.alive) continue;
        if (!p.contactOn && now - p.contactOffSince > GRACE_MS) {
          kill(p, now);
        } else if (now - p.lastContactMsgAt > STALE_MS) {
          kill(p, now);
        }
      }

      const total = state.players.size;
      const aliveCount = [...state.players.values()].filter((p) => p.alive)
        .length;
      if (total > 1 && aliveCount <= 1) {
        endByLastAlive();
        return;
      }
      if (total === 1 && aliveCount === 0) {
        endByLastAlive();
        return;
      }

      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      const p = state.players.get(playerId);
      if (!p || !p.alive) return; // non-participants & the dead are ignored
      if (msg.type !== "contact") return;
      if (typeof msg.on !== "boolean") return;
      // Idempotent state set — accepted during warm-up too (no eliminations
      // happen before startAt; liveInit re-anchors the windows at GO).
      const now = Date.now();
      p.lastContactMsgAt = now;
      if (msg.on !== p.contactOn) {
        p.contactOn = msg.on;
        // Grace counts from the FIRST off edge; repeats don't reset it.
        if (!msg.on) p.contactOffSince = now;
      }
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      const p = state.players.get(playerId);
      if (!p || !p.alive) return;
      p.alive = false;
      p.left = true;
      p.diedAt = Date.now();
      const aliveCount = [...state.players.values()].filter((pp) => pp.alive)
        .length;
      if (aliveCount <= 1) endByLastAlive();
    },
    cleanup() {},
  };
}

const DontLetGoDefinition: MiniGameDefinition = {
  id: "dont-let-go",
  displayName: "Don't Let Go",
  gamemode: "last-man-standing",
  // FFA — match takes the full lobby. matchSize is metadata only here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: DLG_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createDontLetGoMatch,
};

registerMiniGame(DontLetGoDefinition);

export default DontLetGoDefinition;
