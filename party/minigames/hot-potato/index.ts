// Hot Potato — last-man-standing FFA. One alive player is the "holder";
// they tap to pass the potato to a random other alive player. Server-side
// hidden timer (random 4–9s); when it expires the holder is eliminated.
// Pick a fresh starting holder + fresh timer for the next round. Last
// alive wins.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const MIN_TIMER_MS = 4_000;
const MAX_TIMER_MS = 9_000;
/** The potato can't be passed for this long after receiving it. Kills the
 *  spam-tap-where-the-button-will-appear exploit: everyone holds real risk
 *  for at least this window. */
const PASS_ARM_MS = 600;
/** Brief pause after each elimination before the next holder is picked. */
const ELIM_PAUSE_MS = 1_500;
const HP_MATCH_TIMEOUT_MS = 120_000;

type Phase = "live" | "elim-pause" | "ended";

type GameState = {
  phase: Phase;
  alivePlayers: Set<string>;
  holderId: string | null;
  /** Server-only countdown — the heat. Players never see this. */
  timerExpiresAt: number;
  /** When the current holder received the potato (for the pass-arm delay). */
  holderSince: number;
  /** Pause until this time after an elimination. */
  pauseUntil: number;
  /** Most recent elimination, broadcast to clients during the pause. */
  lastEliminated: { playerId: string; nickname: string } | null;
  startedAt: number;
};

function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function createHotPotatoMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: GameState = {
    phase: "live",
    alivePlayers: new Set(players.map((p) => p.playerId)),
    holderId: null,
    timerExpiresAt: 0,
    pauseUntil: 0,
    lastEliminated: null,
    startedAt: ctx.startAt,
    holderSince: ctx.startAt,
  };
  // First holder is random. The hidden timer counts from GO, not creation.
  state.holderId = pickRandom([...state.alivePlayers]);
  state.timerExpiresAt = ctx.startAt + randomTimerMs();

  ctx.broadcast({
    type: "welcome",
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function randomTimerMs(): number {
    return MIN_TIMER_MS + Math.random() * (MAX_TIMER_MS - MIN_TIMER_MS);
  }

  function broadcastState() {
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      holderId: state.holderId,
      alive: [...state.alivePlayers],
      lastEliminated: state.lastEliminated,
      pauseUntil: state.pauseUntil,
      /** Server time when the holder is allowed to pass. */
      armAt: state.holderSince + PASS_ARM_MS,
      // Note: timerExpiresAt is intentionally NOT broadcast.
      deadlineAt: ctx.deadlineAt,
    });
  }

  function eliminateHolder() {
    if (state.holderId === null) return;
    const eliminated = state.holderId;
    const nick = players.find((p) => p.playerId === eliminated)?.nickname ?? "?";
    state.alivePlayers.delete(eliminated);
    state.lastEliminated = { playerId: eliminated, nickname: nick };
    state.holderId = null;

    if (state.alivePlayers.size <= 1) {
      // Round over.
      endByLastAlive();
      return;
    }

    state.phase = "elim-pause";
    state.pauseUntil = Date.now() + ELIM_PAUSE_MS;
  }

  function startNextHolder() {
    state.holderId = pickRandom([...state.alivePlayers]);
    // Anchor to startAt: if the holder changes during warm-up (disconnect),
    // the hidden timer must not burn through the frozen 3s — the replacement
    // could otherwise be eliminated ~1s after GO.
    state.timerExpiresAt = Math.max(Date.now(), ctx.startAt) + randomTimerMs();
    state.holderSince = Math.max(Date.now(), ctx.startAt);
    state.phase = "live";
  }

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  /** Track elimination order to compute placements. */
  const eliminationOrder: string[] = [];

  function computePlacements(): Record<string, number> {
    const out: Record<string, number> = {};
    // Survivors: coinflip among themselves.
    const alive = [...state.alivePlayers];
    shuffleInPlace(alive);
    let rank = 1;
    for (const pid of alive) out[pid] = rank++;
    // Eliminated: reverse order (last-eliminated = best dead rank).
    for (let i = eliminationOrder.length - 1; i >= 0; i--) {
      out[eliminationOrder[i]] = rank++;
    }
    return out;
  }

  function endByLastAlive() {
    if (state.phase === "ended") return;
    state.phase = "ended";
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: winnerNick ? `${winnerNick} survives` : "no winner",
    });
  }

  function endByDeadline() {
    if (state.phase === "ended") return;
    state.phase = "ended";
    const placements = computePlacements();
    const winnerId = Object.entries(placements).find(([, r]) => r === 1)?.[0] ?? null;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      summary: "time's up",
    });
  }

  // Patch eliminateHolder to track order.
  const originalEliminate = eliminateHolder;
  function eliminateHolderTracked() {
    const target = state.holderId;
    if (target) eliminationOrder.push(target);
    originalEliminate();
  }

  return {
    tick() {
      if (state.phase === "ended") return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the frozen scene; nothing advances yet.
        broadcastState();
        return;
      }
      const now = Date.now();
      if (state.phase === "live" && state.holderId && now >= state.timerExpiresAt) {
        eliminateHolderTracked();
      } else if (state.phase === "elim-pause" && now >= state.pauseUntil) {
        startNextHolder();
      }
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.phase !== "live") return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "pass-potato") return;
      if (state.holderId !== playerId) return;
      // Pass-arm delay: taps before the potato "arms" are dropped.
      if (Date.now() - state.holderSince < PASS_ARM_MS) return;
      // Pass to random other alive player.
      const others = [...state.alivePlayers].filter((id) => id !== playerId);
      if (others.length === 0) return;
      const next = pickRandom(others);
      if (!next) return;
      state.holderId = next;
      state.holderSince = Date.now();
      // Timer keeps running; passing doesn't reset it (that's the suspense).
    },
    onPlayerLeft(playerId) {
      if (state.phase === "ended") return;
      if (!state.alivePlayers.has(playerId)) return;
      state.alivePlayers.delete(playerId);
      eliminationOrder.push(playerId);
      // If holder left, pick another holder fresh.
      if (state.holderId === playerId) {
        if (state.alivePlayers.size <= 1) {
          endByLastAlive();
          return;
        }
        startNextHolder();
      }
    },
    cleanup() {},
  };
}

const HotPotatoDefinition: MiniGameDefinition = {
  id: "hot-potato",
  displayName: "Hot Potato",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: HP_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createHotPotatoMatch,
};

registerMiniGame(HotPotatoDefinition);

export default HotPotatoDefinition;
