// Tug of War — tournament 1v1 button masher. A knot on a vertical rope
// starts at 0 (range -100..+100). Every accepted tap of a player's PULL
// button moves the knot 4 units toward that player. First to drag the knot
// fully to their side (|knot| = 100) wins. Pure tap race — no drift — but
// taps are rate-limited server-side to 12/sec per player (excess ignored)
// so autoclickers don't trivially win.
//
// Wire format is canonical: knot > 0 = pulled toward p1, knot < 0 = toward
// p2. p1 wins at +100, p2 wins at -100. Clients flip the sign per role so
// each participant's own side renders at the bottom of their phone.
//
// On deadline (45s) the side the knot is on wins; knot at exactly 0 = draw.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const TUG_RANGE = 100; // knot travels -RANGE..+RANGE
export const TUG_PULL_STEP = 4; // units per accepted tap
const MAX_TAPS_PER_SEC = 12; // server-side rate limit per player
const TUG_MATCH_TIMEOUT_MS = 45_000;

type RateWindow = { windowStart: number; count: number };

type ServerState = {
  /** Canonical knot position: + toward p1, - toward p2. */
  knot: number;
  /** Accepted pull counts (for scores / summary). */
  pulls: { p1: number; p2: number };
  ended: boolean;
};

function createTugOfWarMatch(ctx: MatchContext): MatchSession {
  const [p1, p2] = ctx.players;
  if (!p1 || !p2) {
    throw new Error("Tug of War requires exactly 2 participants");
  }

  const state: ServerState = {
    knot: 0,
    pulls: { p1: 0, p2: 0 },
    ended: false,
  };

  // Sliding-window tap rate limit, one window per player. Rolling 1s
  // window: at most MAX_TAPS_PER_SEC accepted taps per window.
  const rate = new Map<string, RateWindow>([
    [p1.playerId, { windowStart: 0, count: 0 }],
    [p2.playerId, { windowStart: 0, count: 0 }],
  ]);

  // Single welcome broadcast to ALL room members (participants and
  // spectators). Each client derives its own role by comparing
  // selfPlayerId against players.p1 / players.p2.
  ctx.broadcast({
    type: "welcome",
    range: TUG_RANGE,
    pullStep: TUG_PULL_STEP,
    deadlineAt: ctx.deadlineAt,
    players: {
      p1: { playerId: p1.playerId, nickname: p1.nickname, avatarId: p1.avatarId },
      p2: { playerId: p2.playerId, nickname: p2.nickname, avatarId: p2.avatarId },
    },
  });

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      knot: state.knot, // always an integer (steps of 4 from 0)
      pulls: state.pulls,
      deadlineAt: ctx.deadlineAt,
    });
  }

  broadcastState();

  function endByKnot() {
    if (state.ended) return;
    state.ended = true;
    broadcastState();
    const p1Won = state.knot > 0;
    const winner = p1Won ? p1 : p2;
    ctx.endMatch({
      winnerId: winner.playerId,
      scores: {
        [p1.playerId]: state.pulls.p1,
        [p2.playerId]: state.pulls.p2,
      },
      summary: `${winner.nickname} wins the tug (${p1Won ? state.pulls.p1 : state.pulls.p2} pulls)`,
    });
  }

  function endByDeadline() {
    if (state.ended) return;
    state.ended = true;
    broadcastState();
    let winnerId: string | null;
    if (state.knot > 0) winnerId = p1.playerId;
    else if (state.knot < 0) winnerId = p2.playerId;
    else winnerId = null; // knot dead-center → draw (gamemode resolves)
    const summary =
      winnerId === null
        ? "time's up · dead even"
        : `time's up · ${winnerId === p1.playerId ? p1.nickname : p2.nickname} had the edge`;
    ctx.endMatch({
      winnerId,
      scores: {
        [p1.playerId]: state.pulls.p1,
        [p2.playerId]: state.pulls.p2,
      },
      summary,
    });
  }

  return {
    tick() {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the frozen scene; inputs are ignored.
        broadcastState();
        return;
      }
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "pull") return;
      const isP1 = playerId === p1.playerId;
      const isP2 = playerId === p2.playerId;
      if (!isP1 && !isP2) return; // not a participant

      // Rate limit: rolling 1-second window, max MAX_TAPS_PER_SEC accepted.
      const w = rate.get(playerId)!;
      const now = Date.now();
      if (now - w.windowStart >= 1000) {
        w.windowStart = now;
        w.count = 0;
      }
      if (w.count >= MAX_TAPS_PER_SEC) return; // excess tap ignored
      w.count++;

      if (isP1) {
        state.knot += TUG_PULL_STEP;
        state.pulls.p1++;
      } else {
        state.knot -= TUG_PULL_STEP;
        state.pulls.p2++;
      }
      state.knot = Math.max(-TUG_RANGE, Math.min(TUG_RANGE, state.knot));
      if (state.knot >= TUG_RANGE || state.knot <= -TUG_RANGE) {
        endByKnot();
      }
    },
    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (playerId === p1.playerId || playerId === p2.playerId) {
        const survivorId = playerId === p1.playerId ? p2.playerId : p1.playerId;
        const survivorNick =
          survivorId === p1.playerId ? p1.nickname : p2.nickname;
        state.ended = true;
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

const TugOfWarDefinition: MiniGameDefinition = {
  id: "tug-of-war",
  displayName: "Tug of War",
  gamemode: "tournament",
  matchSize: 2,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: TUG_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createTugOfWarMatch,
};

registerMiniGame(TugOfWarDefinition);

export default TugOfWarDefinition;
