// LastManStandingGamemode — single FFA match with all lobby players.
// Match ends when all-but-one are dead, OR after the mini-game's matchTimeoutMs
// (5 min for Flappy Bird). At timeout, surviving players get coinflip
// placements above all dead players.
//
// Phases (per gamemode session):
//   intro      – brief countdown ("Starting in N…") with the player roster
//   playing    – the FFA match runs full-screen
//   complete   – flashed momentarily before the lobby transitions to round-results
//
// The match itself is responsible for:
//   • tracking deaths and producing `placements` in the MatchEndResult
//   • watching `ctx.deadlineAt` and self-ending with coinflip placements at
//     timeout
// The gamemode just sets up the match, ticks it, and forwards results.

import type { MatchContext, MatchSession } from "../../minigames/types";
import { registerGamemode } from "../registry";
import type {
  GamemodeContext,
  GamemodeDefinition,
  GamemodeSession,
  MatchEndResult,
  MiniGamePlayer,
} from "../types";

const INTRO_MS = 5_000;
const MATCH_FORCE_GRACE_MS = 5_000;
const MATCH_ID = "lms";

type Phase = "intro" | "playing" | "complete";

function createLastManStandingSession(
  ctx: GamemodeContext,
): GamemodeSession {
  const lobbyPlayers = ctx.lobbyPlayers;
  if (lobbyPlayers.length < 1) {
    throw new Error("Last Man Standing requires at least 1 player");
  }

  let phase: Phase = "intro";
  let phaseEndsAt: number | null = Date.now() + INTRO_MS;
  let phaseTimer: ReturnType<typeof setTimeout> | null = null;
  let matchSession: MatchSession | null = null;
  let participantsAtStart: MiniGamePlayer[] = lobbyPlayers;
  let deadlineAt = 0;
  let matchEnded = false;
  let ended = false;
  const disconnectedIds = new Set<string>();

  function broadcastState() {
    ctx.broadcastGamemode({
      type: "lms-state",
      phase,
      phaseEndsAt,
      matchId: MATCH_ID,
      players: participantsAtStart.map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        avatarId: p.avatarId,
      })),
    });
  }

  function startMatch() {
    if (ended) return;
    // Filter out players who left during the intro.
    participantsAtStart = lobbyPlayers.filter(
      (p) => !disconnectedIds.has(p.playerId),
    );
    if (participantsAtStart.length < 1) {
      completeMatch({ winnerId: null, summary: "everyone left during intro" });
      return;
    }

    phase = "playing";
    phaseEndsAt = null;
    deadlineAt = Date.now() + ctx.miniGame.matchTimeoutMs;
    const participantIds = participantsAtStart.map((p) => p.playerId);

    // Active participants → clicker off (focused).
    for (const pid of participantIds) ctx.setClickerAvailable(pid, false);

    // Broadcast lms-state FIRST so clients mount the match scene before the
    // mini-game's welcome arrives.
    broadcastState();

    const matchCtx: MatchContext = {
      matchId: MATCH_ID,
      players: participantsAtStart,
      deadlineAt,
      broadcast: (msg) => ctx.broadcastMatch(MATCH_ID, participantIds, msg),
      sendTo: (pid, msg) => ctx.sendMatch(MATCH_ID, pid, msg),
      endMatch: (result) => completeMatch(result),
      log: (...args) => ctx.log("[lms-match]", ...args),
    };
    matchSession = ctx.miniGame.createMatch(matchCtx);
  }

  function completeMatch(result: MatchEndResult) {
    if (ended || matchEnded) return;
    matchEnded = true;
    if (matchSession) {
      try {
        matchSession.cleanup();
      } catch (e) {
        ctx.log("[lms] match cleanup err", e);
      }
    }
    matchSession = null;

    const placements = result.placements ?? fallbackPlacements(result.winnerId);
    const points = placementsToPoints(placements);

    phase = "complete";
    phaseEndsAt = null;

    // Tell match clients to unmount their scene.
    ctx.broadcastMatch(
      MATCH_ID,
      participantsAtStart.map((p) => p.playerId),
      {
        type: "match-ended",
        winnerId: result.winnerId,
        summary: result.summary ?? null,
      },
    );
    broadcastState();

    for (const p of participantsAtStart) {
      ctx.setClickerAvailable(p.playerId, true);
    }

    ended = true;
    ctx.endRound({
      points,
      summary: result.summary,
      participants: participantsAtStart.map((p) => p.playerId),
    });
  }

  function fallbackPlacements(winnerId: string | null): Record<string, number> {
    // Used only if the match forgot to provide placements. Winner first,
    // everyone else tied at last place.
    const out: Record<string, number> = {};
    let rank = 1;
    if (winnerId) out[winnerId] = rank++;
    for (const p of participantsAtStart) {
      if (p.playerId === winnerId) continue;
      out[p.playerId] = rank;
    }
    return out;
  }

  function tickFn(dt: number) {
    if (ended) return;
    if (phase !== "playing" || !matchSession) return;
    try {
      matchSession.tick?.(dt);
    } catch (e) {
      ctx.log("[lms] match tick err", e);
    }
    if (matchEnded) return;
    if (Date.now() > deadlineAt + MATCH_FORCE_GRACE_MS) {
      ctx.log("[lms] force-ending stuck match");
      completeMatch({ winnerId: null, summary: "match force-ended (timeout)" });
    }
  }

  // ─── kick off ────────────────────────────────────────────────────────────

  for (const p of lobbyPlayers) ctx.setClickerAvailable(p.playerId, false);
  broadcastState();
  phaseTimer = setTimeout(() => {
    phaseTimer = null;
    if (ended) return;
    startMatch();
  }, INTRO_MS);

  return {
    tick: tickFn,
    onMatchMessage(playerId, matchId, msg) {
      if (matchId !== MATCH_ID || matchEnded || !matchSession) return;
      matchSession.onMessage(playerId, msg);
    },
    onPlayerLeft(playerId) {
      disconnectedIds.add(playerId);
      if (matchSession && !matchEnded) {
        try {
          matchSession.onPlayerLeft?.(playerId);
        } catch (e) {
          ctx.log("[lms] match.onPlayerLeft err", e);
        }
      }
    },
    cleanup() {
      ended = true;
      if (phaseTimer) clearTimeout(phaseTimer);
      if (matchSession) {
        try {
          matchSession.cleanup();
        } catch {
          /* ignore */
        }
      }
      matchSession = null;
    },
  };
}

function placementsToPoints(
  placements: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pid, p] of Object.entries(placements)) {
    out[pid] = pointsForPlacement(p);
  }
  return out;
}

function pointsForPlacement(placement: number): number {
  if (placement === 1) return 10;
  if (placement === 2) return 5;
  if (placement === 3) return 3;
  if (placement <= 5) return 1;
  return 0;
}

const LastManStandingDefinition: GamemodeDefinition = {
  id: "last-man-standing",
  displayName: "Last Man Standing",
  tickHz: 30,
  createSession: createLastManStandingSession,
};

registerGamemode(LastManStandingDefinition);

export default LastManStandingDefinition;
