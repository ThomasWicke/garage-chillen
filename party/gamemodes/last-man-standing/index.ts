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

// Roster intro is short — the warm-up phase that follows shows the actual
// game scene behind a 3-2-1-GO overlay, which is the real "get ready" time.
const INTRO_MS = 3_000;
/** Test-lobby fast mode. */
const FAST_INTRO_MS = 1_500;
/** Scene visible but simulation frozen for this long before GO. */
const WARMUP_MS = 3_000;
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

  const introMs = ctx.test?.fast ? FAST_INTRO_MS : INTRO_MS;
  let phase: Phase = "intro";
  let phaseEndsAt: number | null = Date.now() + introMs;
  let phaseTimer: ReturnType<typeof setTimeout> | null = null;
  let matchSession: MatchSession | null = null;
  let participantsAtStart: MiniGamePlayer[] = lobbyPlayers;
  let deadlineAt = 0;
  /** Server-time when the match's simulation starts (end of warm-up). */
  let goAt: number | null = null;
  let matchEnded = false;
  let ended = false;
  const disconnectedIds = new Set<string>();
  /** Last welcome the match emitted — replayed to players who reconnect
   *  mid-match so their client can rebuild the scene. */
  let lastWelcome: { type: string; [k: string]: unknown } | null = null;

  function buildStateMsg() {
    return {
      type: "lms-state",
      phase,
      phaseEndsAt,
      goAt: phase === "playing" ? goAt : null,
      matchId: MATCH_ID,
      players: participantsAtStart.map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        avatarId: p.avatarId,
      })),
    };
  }

  function broadcastState() {
    ctx.broadcastGamemode(buildStateMsg());
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
    const startAt = Date.now() + WARMUP_MS;
    goAt = startAt;
    // Warm-up doesn't eat into play time.
    deadlineAt = startAt + ctx.miniGame.matchTimeoutMs;
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
      startAt,
      broadcast: (msg) => {
        if (msg.type === "welcome") lastWelcome = msg;
        ctx.broadcastMatch(MATCH_ID, participantIds, msg);
      },
      sendTo: (pid, msg) => {
        // Per-player welcomes (e.g. Flappy Bird) carry the same payload for
        // everyone, so keeping the last one is enough for replay.
        if (msg.type === "welcome") lastWelcome = msg;
        ctx.sendMatch(MATCH_ID, pid, msg);
      },
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

    // Broadcast the "complete" lms-state BEFORE match-ended: the client's
    // match-ended handler unmounts and rerenders, and if it still saw
    // phase:"playing" it would remount a fresh match scene ("connecting…")
    // for the moment until the complete state arrived.
    broadcastState();
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
    // everyone else tied at LAST place. (Careful: a null winner must not
    // leave everyone at rank 1 — a force-ended round would award 10 points
    // to the whole lobby.)
    const out: Record<string, number> = {};
    const lastPlace = Math.max(2, participantsAtStart.length);
    if (winnerId) out[winnerId] = 1;
    for (const p of participantsAtStart) {
      if (p.playerId === winnerId) continue;
      out[p.playerId] = lastPlace;
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
  }, introMs);

  return {
    tick: tickFn,
    onMatchMessage(playerId, matchId, msg) {
      if (matchId !== MATCH_ID || matchEnded || !matchSession) return;
      // Gate to actual participants — mid-match joiners and intro-leavers
      // must not reach the match (e.g. whack-a-mole scores ANY playerId it
      // sees, so an ungated outsider could win the round).
      if (!participantsAtStart.some((p) => p.playerId === playerId)) return;
      matchSession.onMessage(playerId, msg);
    },
    matchIdFor(playerId) {
      if (phase !== "playing" || matchEnded || !matchSession) return null;
      return participantsAtStart.some((p) => p.playerId === playerId)
        ? MATCH_ID
        : null;
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
    onPlayerRejoined(playerId) {
      if (ended) return;
      // Back during the intro → they play after all.
      if (phase === "intro") disconnectedIds.delete(playerId);
      // Re-send current gamemode state, then the match welcome so the
      // client can rebuild the match scene it never saw (or tore down).
      ctx.sendGamemode(playerId, buildStateMsg());
      if (phase === "playing" && !matchEnded && lastWelcome) {
        ctx.sendMatch(MATCH_ID, playerId, lastWelcome);
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
