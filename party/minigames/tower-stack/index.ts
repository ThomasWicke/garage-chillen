// Tower Stack — last-man-standing FFA. Classic arcade Stacker: every player
// builds an INDEPENDENT tower. A block slides back and forth above the tower
// (faster each level); tap to drop it. Overhang beyond the block below is cut
// off, so the block shrinks — width <= 0 or a complete miss ends that
// player's run. Height (levels placed) is the score.
//
// Determinism: the server does NOT broadcast per-tick block positions.
// Instead it broadcasts oscillation params {centerX, amplitude, speed,
// anchorT}; clients animate locally from the same formula for buttery
// motion, and on "drop" the server recomputes the block x from ITS OWN
// clock — small client/server divergence is acceptable, server wins.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const TWR_FIELD_W = 500;
export const TWR_FIELD_H = 800;
export const TWR_BLOCK_H = 34;
export const TWR_START_WIDTH = 200;

const BASE_SPEED = 140; // px/s at level 0
const SPEED_PER_LEVEL = 12; // px/s added per placed level
const TWR_MATCH_TIMEOUT_MS = 90_000;
/** Only the top blocks of each tower go on the wire — clients never render
 *  more than a screen's worth anyway. Keeps 16-player state broadcasts small. */
const MAX_WIRE_BLOCKS = 20;
/** Server-side double-tap guard: drops closer together than this are ignored
 *  (a jittery double-tap should not insta-miss the freshly spawned block). */
const MIN_DROP_GAP_MS = 150;

type Osc = {
  centerX: number;
  amplitude: number;
  speed: number;
  anchorT: number;
};

type Tower = {
  playerId: string;
  /** Placed blocks, bottom-up. Foundation (width TWR_START_WIDTH, centered)
   *  is implicit and not part of this list. */
  blocks: { x: number; w: number }[];
  /** Width of the currently sliding block. */
  width: number;
  osc: Osc;
  done: boolean;
  left: boolean;
  lastDropAt: number;
};

/** Ping-pong position of the sliding block center at server time t. */
function oscXAt(osc: Osc, t: number): number {
  if (osc.amplitude <= 0) return osc.centerX;
  const elapsed = Math.max(0, t - osc.anchorT) / 1000;
  const range = 2 * osc.amplitude;
  const p = (elapsed * osc.speed) % (2 * range);
  const offset = p <= range ? p : 2 * range - p;
  return osc.centerX - osc.amplitude + offset;
}

function createTowerStackMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const towers = new Map<string, Tower>();
  let ended = false;

  function makeOsc(width: number, level: number, anchorT: number): Osc {
    return {
      centerX: Math.round(TWR_FIELD_W / 2),
      amplitude: Math.max(0, Math.round((TWR_FIELD_W - width) / 2)),
      speed: BASE_SPEED + SPEED_PER_LEVEL * level,
      anchorT: Math.round(anchorT),
    };
  }

  for (const p of players) {
    towers.set(p.playerId, {
      playerId: p.playerId,
      blocks: [],
      width: TWR_START_WIDTH,
      // Anchored to GO: during warm-up clients clamp elapsed to 0, so the
      // block sits frozen at the left edge and starts moving exactly at GO.
      osc: makeOsc(TWR_START_WIDTH, 0, ctx.startAt),
      done: false,
      left: false,
      lastDropAt: 0,
    });
  }

  ctx.broadcast({
    type: "welcome",
    field: { w: TWR_FIELD_W, h: TWR_FIELD_H },
    blockH: TWR_BLOCK_H,
    startWidth: TWR_START_WIDTH,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
    deadlineAt: ctx.deadlineAt,
  });

  function broadcastState() {
    const playersObj: Record<string, unknown> = {};
    for (const [pid, t] of towers) {
      const from = Math.max(0, t.blocks.length - MAX_WIRE_BLOCKS);
      playersObj[pid] = {
        level: t.blocks.length,
        done: t.done,
        left: t.left,
        width: Math.max(0, Math.round(t.width)),
        osc: t.osc,
        from,
        blocks: t.blocks
          .slice(from)
          .map((b) => [Math.round(b.x), Math.max(1, Math.round(b.w))]),
      };
    }
    ctx.broadcast({
      type: "state",
      players: playersObj,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function handleDrop(t: Tower) {
    const now = Date.now();
    if (now - t.lastDropAt < MIN_DROP_GAP_MS) return;
    t.lastDropAt = now;

    // Server-authoritative x from the server's own clock.
    const x = oscXAt(t.osc, now);
    const prev =
      t.blocks.length > 0
        ? t.blocks[t.blocks.length - 1]
        : { x: TWR_FIELD_W / 2, w: TWR_START_WIDTH };

    const overlapL = Math.max(x - t.width / 2, prev.x - prev.w / 2);
    const overlapR = Math.min(x + t.width / 2, prev.x + prev.w / 2);
    const overlap = overlapR - overlapL;

    if (overlap <= 0) {
      // Complete miss — this player is done.
      t.done = true;
      return;
    }

    // Overhang cut off: the placed block is the overlap region.
    t.blocks.push({ x: (overlapL + overlapR) / 2, w: overlap });
    t.width = overlap;
    const level = t.blocks.length;
    // New sliding block, faster, with a randomized phase so towers desync.
    const osc = makeOsc(overlap, level, 0);
    const periodMs = osc.speed > 0 ? ((4 * osc.amplitude) / osc.speed) * 1000 : 0;
    osc.anchorT = Math.round(now - Math.random() * periodMs);
    t.osc = osc;
  }

  /** Placements by levels desc; equal levels SHARE a rank. Players who
   *  disconnected rank below everyone who finished naturally. */
  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    const active = [...towers.values()]
      .filter((t) => !t.left)
      .sort((a, b) => b.blocks.length - a.blocks.length);
    const forfeits = [...towers.values()]
      .filter((t) => t.left)
      .sort((a, b) => b.blocks.length - a.blocks.length);
    let rank = 1;
    for (const group of [active, forfeits]) {
      let i = 0;
      while (i < group.length) {
        let j = i;
        while (
          j < group.length &&
          group[j].blocks.length === group[i].blocks.length
        ) {
          j++;
        }
        for (let g = i; g < j; g++) out[group[g].playerId] = rank;
        rank += j - i;
        i = j;
      }
    }
    return out;
  }

  function endMatchNow(timeUp: boolean) {
    if (ended) return;
    ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const topLevel = Math.max(
      0,
      ...topIds.map((id) => towers.get(id)?.blocks.length ?? 0),
    );
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    const summary = winnerNick
      ? `${timeUp ? "time's up · " : ""}${winnerNick} stacked ${topLevel} high`
      : `${timeUp ? "time's up · " : ""}tie at ${topLevel} high`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, summary });
  }

  return {
    tick() {
      if (ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        // Graceful timeout: players still stacking use their current level.
        endMatchNow(true);
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the frozen scene; nothing advances yet.
        broadcastState();
        return;
      }
      const allDone = [...towers.values()].every((t) => t.done);
      if (allDone) {
        endMatchNow(false);
        return;
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "drop") return;
      const t = towers.get(playerId);
      if (!t || t.done || t.left) return;
      handleDrop(t);
    },
    onPlayerLeft(playerId) {
      const t = towers.get(playerId);
      if (!t) return;
      t.left = true;
      t.done = true;
    },
    cleanup() {},
  };
}

const TowerStackDefinition: MiniGameDefinition = {
  id: "tower-stack",
  displayName: "Tower Stack",
  gamemode: "last-man-standing",
  // FFA — match takes the full lobby. matchSize is metadata only here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: TWR_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createTowerStackMatch,
};

registerMiniGame(TowerStackDefinition);

export default TowerStackDefinition;
