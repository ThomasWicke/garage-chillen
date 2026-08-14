// Bubble Wrap — last-man-standing FFA speed race. Every player gets their
// OWN identical 6×9 sheet of 54 bubbles and pops them as fast as possible.
// First to pop all 54 wins; the match ends 5s after the first finisher
// (grace window so close finishers rank by their own finish time), or when
// every active player has finished, or at the deadline.
//
// Wire protocol (documented for the client):
//   welcome: { grid: {cols, rows, total}, graceMs, deadlineAt, players }
//   state:   { counts: Record<pid, int>, finishedAt: Record<pid, ts|0>,
//              grids: Record<pid, hexMask>,  // 7-byte hex bitmask of popped
//              graceEndsAt,                  // 0 until someone finishes
//              deadlineAt }
//   Grids are broadcast so a reconnecting client can rebuild its sheet from
//   the welcome replay + latest state (and so spectators can watch).
// Client → server: { type: "pop", index: 0..53 } (repeats ignored)

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const BW_COLS = 6;
export const BW_ROWS = 9;
export const BW_TOTAL = BW_COLS * BW_ROWS; // 54

const GRACE_MS = 5_000;
const BW_MATCH_TIMEOUT_MS = 60_000;

type PlayerState = {
  playerId: string;
  popped: boolean[];
  count: number;
  finishedAt: number; // 0 = not finished
  left: boolean;
};

type GameState = {
  players: Map<string, PlayerState>;
  graceEndsAt: number; // 0 until the first finisher
  ended: boolean;
};

/** Encode a 54-bubble popped array as a 7-byte hex string (LSB-first). */
function maskHex(popped: boolean[]): string {
  let out = "";
  for (let byte = 0; byte < 7; byte++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) {
      const idx = byte * 8 + bit;
      if (idx < BW_TOTAL && popped[idx]) v |= 1 << bit;
    }
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

function createBubbleWrapMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: GameState = {
    players: new Map(
      players.map((p) => [
        p.playerId,
        {
          playerId: p.playerId,
          popped: new Array<boolean>(BW_TOTAL).fill(false),
          count: 0,
          finishedAt: 0,
          left: false,
        },
      ]),
    ),
    graceEndsAt: 0,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    grid: { cols: BW_COLS, rows: BW_ROWS, total: BW_TOTAL },
    graceMs: GRACE_MS,
    // Clients gate local (optimistic) pops on this so a warm-up tap can't
    // deflate a bubble the server refuses to count.
    startAt: ctx.startAt,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    const counts: Record<string, number> = {};
    const finishedAt: Record<string, number> = {};
    const grids: Record<string, string> = {};
    for (const [pid, ps] of state.players) {
      counts[pid] = ps.count;
      finishedAt[pid] = ps.finishedAt;
      grids[pid] = maskHex(ps.popped);
    }
    ctx.broadcast({
      type: "state",
      counts,
      finishedAt,
      grids,
      graceEndsAt: state.graceEndsAt,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function computePlacements(): Record<string, number> {
    const all = [...state.players.values()];
    // Finishers rank by their own finish time (earlier = better); identical
    // timestamps SHARE a rank.
    const finishers = all
      .filter((p) => p.finishedAt > 0)
      .sort((a, b) => a.finishedAt - b.finishedAt);
    // Unfinished rank by popped count desc; count ties share a rank.
    // Forfeits (disconnects) rank below every still-connected unfinished
    // player, ordered by their standing count among themselves.
    const rest = all
      .filter((p) => p.finishedAt === 0)
      .sort((a, b) => {
        if (a.left !== b.left) return a.left ? 1 : -1;
        return b.count - a.count;
      });
    const out: Record<string, number> = {};
    let rank = 1;
    let i = 0;
    while (i < finishers.length) {
      let j = i;
      while (j < finishers.length && finishers[j].finishedAt === finishers[i].finishedAt) j++;
      for (let g = i; g < j; g++) out[finishers[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    i = 0;
    while (i < rest.length) {
      let j = i;
      while (
        j < rest.length &&
        rest[j].count === rest[i].count &&
        rest[j].left === rest[i].left
      ) j++;
      for (let g = i; g < j; g++) out[rest[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    return out;
  }

  function endNow(timeUp: boolean) {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const scores: Record<string, number> = {};
    for (const [pid, ps] of state.players) scores[pid] = ps.count;
    let summary: string;
    if (winnerId) {
      const nick = players.find((p) => p.playerId === winnerId)?.nickname ?? "?";
      const winner = state.players.get(winnerId)!;
      summary =
        winner.finishedAt > 0
          ? `${nick} pops all ${BW_TOTAL} in ${((winner.finishedAt - ctx.startAt) / 1000).toFixed(1)}s`
          : `${timeUp ? "time's up · " : ""}${nick} leads with ${winner.count}/${BW_TOTAL}`;
    } else {
      summary = timeUp ? "time's up · tie" : "photo finish · tie";
    }
    broadcastState();
    ctx.endMatch({ winnerId, placements, scores, summary });
  }

  function allActiveFinished(): boolean {
    let sawActive = false;
    for (const ps of state.players.values()) {
      if (ps.left) continue;
      sawActive = true;
      if (ps.finishedAt === 0) return false;
    }
    return sawActive; // if everyone left, the leave handler ends the match
  }

  return {
    tick() {
      if (state.ended) return;
      const now = Date.now();
      if (now >= ctx.deadlineAt) {
        endNow(true);
        return;
      }
      if (now < ctx.startAt) {
        // Warm-up: clients render the untouched sheet; inputs are ignored.
        broadcastState();
        return;
      }
      if (state.graceEndsAt > 0 && now >= state.graceEndsAt) {
        endNow(false);
        return;
      }
      if (allActiveFinished()) {
        endNow(false);
        return;
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "pop") return;
      const ps = state.players.get(playerId);
      if (!ps || ps.left) return; // not a participant / forfeited
      const raw = msg.index;
      if (typeof raw !== "number" || !Number.isFinite(raw)) return;
      const index = Math.floor(raw);
      if (index < 0 || index >= BW_TOTAL) return;
      if (ps.popped[index]) return; // repeat — ignore
      ps.popped[index] = true;
      ps.count++;
      if (ps.count >= BW_TOTAL && ps.finishedAt === 0) {
        ps.finishedAt = Date.now();
        if (state.graceEndsAt === 0) {
          state.graceEndsAt = ps.finishedAt + GRACE_MS;
        }
      }
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      const ps = state.players.get(playerId);
      if (!ps) return;
      ps.left = true; // finished leavers keep their finish; others forfeit
      // If everyone still connected has finished (or everyone left), wrap up.
      const anyActive = [...state.players.values()].some((p) => !p.left);
      if (!anyActive || allActiveFinished()) endNow(false);
    },
    cleanup() {},
  };
}

const BubbleWrapDefinition: MiniGameDefinition = {
  id: "bubble-wrap",
  displayName: "Bubble Wrap",
  gamemode: "last-man-standing",
  // FFA — the match takes the full lobby; matchSize is metadata here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: BW_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createBubbleWrapMatch,
};

registerMiniGame(BubbleWrapDefinition);

export default BubbleWrapDefinition;
