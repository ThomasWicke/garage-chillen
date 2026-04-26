// LobbyServer — one instance per lobby code. Owns identity, GM role, and the
// active round (with optional bracket). Keys players by `playerId` so refresh
// / lost-wifi / closed-tab all reconnect cleanly to the same slot.
//
// Lobby state machine:
//   idle → preparing → playing (one or more matches) → round-results → idle
//
// For format: "1v1" mini-games the lobby orchestrates a single-elimination
// bracket across all connected lobby players. The mini-game is instantiated
// once per match in the bracket, with a brief intermission between matches.
// For format: "ffa" mini-games the round is a single session.

import type * as Party from "partykit/server";
import {
  buildBracket,
  isComplete,
  nextMatch,
  placements,
  placementsToPoints,
  recordMatchResult,
  type Bracket,
  type BracketMatch,
} from "./bracket";
import { PlayerRegistry, type PlayerRecord } from "./identity";
import { allMiniGames, getMiniGame } from "./minigames";
import type {
  MiniGameContext,
  MiniGamePlayer,
  MiniGameSession,
} from "./minigames/types";
import type {
  AvailableMiniGamesMsg,
  ClientToServer,
  IdentifyMsg,
  LobbyState,
  LobbyStateMsg,
  MiniGameInfo,
  MiniGameMsg,
  PlayerListMsg,
  PublicBracket,
  RoundResult,
  ServerToClient,
  SessionStateMsg,
  WelcomeMsg,
} from "./protocol";

const GM_GRACE_MS = 30_000;
const PREPARE_COUNTDOWN_MS = 3_000;
const ROUND_RESULTS_AUTO_DISMISS_MS = 15_000;
const INTERMISSION_MS = 3_000;

type ActiveRound = {
  minigameId: string;
  format: "1v1" | "ffa";
  /** Random seed of bracket participants (full lobby for 1v1; single match for FFA). */
  bracket: Bracket | null;
  /** Match summary across the round, accumulated as matches finish. Used for round summary. */
  matchSummaries: string[];
  /** Currently-active match (for 1v1) or the synthetic single FFA match. */
  currentMatchId: string | null;
  currentParticipants: MiniGamePlayer[];
  session: MiniGameSession | null;
  tickHandle: ReturnType<typeof setInterval> | null;
  lastTickAt: number;
  /** While > Date.now(): no match is active; clients show an intermission. */
  intermissionUntil: number | null;
  intermissionTimer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
};

export default class LobbyServer implements Party.Server {
  private registry = new PlayerRegistry();
  private gmPlayerId: string | null = null;
  private gmGraceUntil: number | null = null;
  private gmGraceTimer: ReturnType<typeof setTimeout> | null = null;

  private state: LobbyState = "idle";
  private active: ActiveRound | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private prepareUntil = 0;
  private prepareMinigameId = "";
  private lastResult: RoundResult | null = null;
  private resultsAutoDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionScores: Record<string, number> = {};

  constructor(readonly room: Party.Room) {}

  onConnect(_conn: Party.Connection) {
    // Wait for `identify` before adding to registry.
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw) as ClientToServer;
    } catch {
      return;
    }
    if (!msg) return;

    if (msg.scope === "presence") {
      switch (msg.type) {
        case "identify":
          return this.handleIdentify(msg, sender);
        case "set-nickname": {
          const player = this.registry.getByConnection(sender.id);
          if (!player) return;
          this.registry.setNickname(player.playerId, msg.nickname);
          this.broadcastPlayerList();
          return;
        }
        case "set-avatar": {
          const player = this.registry.getByConnection(sender.id);
          if (!player) return;
          this.registry.setAvatar(player.playerId, msg.avatarId);
          this.broadcastPlayerList();
          return;
        }
      }
      return;
    }

    if (msg.scope === "lobby") {
      const player = this.registry.getByConnection(sender.id);
      if (!player) return;
      const isGm = player.playerId === this.gmPlayerId;
      if (msg.type === "start-round") {
        if (!isGm) return;
        this.requestStartRound(msg.minigameId);
      } else if (msg.type === "back-to-lobby") {
        if (!isGm) return;
        this.transitionToIdle();
      }
      return;
    }

    if (msg.scope === "minigame") {
      if (this.state !== "playing" || !this.active?.session) return;
      const player = this.registry.getByConnection(sender.id);
      if (!player) return;
      this.active.session.onMessage(player.playerId, msg as MiniGameMsg);
      return;
    }
  }

  onClose(conn: Party.Connection) {
    const player = this.registry.disconnect(conn.id);
    if (!player) return;
    console.log(
      `[lobby] onClose: ${player.nickname} (${player.playerId.slice(0, 4)}), state=${this.state}`,
    );
    if (player.playerId === this.gmPlayerId) {
      this.startGmGrace();
    }
    if (this.active?.session) {
      this.active.session.onPlayerLeft?.(player.playerId);
    }
    this.broadcastPlayerList();
  }

  // ─── identify ────────────────────────────────────────────────────────────

  private handleIdentify(msg: IdentifyMsg, sender: Party.Connection) {
    if (!msg.playerId || typeof msg.playerId !== "string") return;
    const { record } = this.registry.upsert({
      playerId: msg.playerId,
      nickname: msg.nickname || "anon",
      avatarId: msg.avatarId || "bean",
      connectionId: sender.id,
    });

    if (this.gmPlayerId === null) {
      this.gmPlayerId = record.playerId;
    } else if (record.playerId === this.gmPlayerId) {
      this.cancelGmGrace();
    }

    this.send<WelcomeMsg>(sender, {
      scope: "presence",
      type: "welcome",
      selfPlayerId: record.playerId,
      lobbyCode: this.room.id,
    });
    this.send<AvailableMiniGamesMsg>(sender, {
      scope: "lobby",
      type: "available-minigames",
      minigames: allMiniGames().map<MiniGameInfo>((m) => ({
        id: m.id,
        displayName: m.displayName,
        minPlayers: m.minPlayers,
        maxPlayers: m.maxPlayers,
        format: m.format,
      })),
    });
    this.send<SessionStateMsg>(sender, {
      scope: "lobby",
      type: "session-state",
      scores: this.sessionScores,
    });
    this.sendCurrentLobbyState(sender);
    this.broadcastPlayerList();
  }

  // ─── GM grace period ─────────────────────────────────────────────────────

  private startGmGrace() {
    this.gmGraceUntil = Date.now() + GM_GRACE_MS;
    if (this.gmGraceTimer) clearTimeout(this.gmGraceTimer);
    this.gmGraceTimer = setTimeout(() => this.resolveGmGrace(), GM_GRACE_MS);
    this.broadcastPlayerList();
  }

  private cancelGmGrace() {
    this.gmGraceUntil = null;
    if (this.gmGraceTimer) {
      clearTimeout(this.gmGraceTimer);
      this.gmGraceTimer = null;
    }
  }

  private resolveGmGrace() {
    this.gmGraceTimer = null;
    this.gmGraceUntil = null;
    const currentGm = this.gmPlayerId
      ? this.registry.getByPlayerId(this.gmPlayerId)
      : null;
    if (currentGm?.connectionId) {
      this.broadcastPlayerList();
      return;
    }
    const heir = this.registry.longestConnected(this.gmPlayerId ?? undefined);
    this.gmPlayerId = heir?.playerId ?? null;
    this.broadcastPlayerList();
  }

  // ─── round lifecycle ─────────────────────────────────────────────────────

  private requestStartRound(minigameId: string) {
    if (this.state !== "idle") return;
    const def = getMiniGame(minigameId);
    if (!def) return;

    const lobbyPlayers = this.lobbyPlayersForMinigame();
    console.log(
      `[lobby] requestStartRound: ${minigameId}, lobbyPlayers=${lobbyPlayers.length}, minP=${def.minPlayers}, maxP=${def.maxPlayers}`,
    );
    if (lobbyPlayers.length < def.minPlayers) return;
    if (lobbyPlayers.length > def.maxPlayers) return;

    this.prepareMinigameId = def.id;
    this.prepareUntil = Date.now() + PREPARE_COUNTDOWN_MS;
    this.state = "preparing";
    this.broadcastLobbyState();

    this.prepareTimer = setTimeout(
      () => this.transitionToPlaying(),
      PREPARE_COUNTDOWN_MS,
    );
  }

  private transitionToPlaying() {
    this.prepareTimer = null;
    if (this.state !== "preparing") return;
    const def = getMiniGame(this.prepareMinigameId);
    if (!def) {
      this.transitionToIdle();
      return;
    }

    const lobbyPlayers = this.lobbyPlayersForMinigame();
    if (lobbyPlayers.length < def.minPlayers) {
      this.transitionToIdle();
      return;
    }

    this.state = "playing";

    if (def.format === "1v1") {
      // Build the bracket from all connected lobby players.
      const bracket = buildBracket(lobbyPlayers.map((p) => p.playerId));
      this.active = {
        minigameId: def.id,
        format: "1v1",
        bracket,
        matchSummaries: [],
        currentMatchId: null,
        currentParticipants: [],
        session: null,
        tickHandle: null,
        lastTickAt: 0,
        intermissionUntil: null,
        intermissionTimer: null,
        ended: false,
      };
      this.startNextMatchOrFinalize();
      return;
    }

    // FFA path: single match with whatever pickParticipants returns.
    const participants = def.pickParticipants(lobbyPlayers);
    if (participants.length < def.minPlayers) {
      this.transitionToIdle();
      return;
    }
    this.active = {
      minigameId: def.id,
      format: "ffa",
      bracket: null,
      matchSummaries: [],
      currentMatchId: "ffa",
      currentParticipants: participants,
      session: null,
      tickHandle: null,
      lastTickAt: 0,
      intermissionUntil: null,
      intermissionTimer: null,
      ended: false,
    };
    this.startMatch(participants);
  }

  /**
   * Kick off the next bracket match, or finalize the round if the bracket is
   * complete. For FFA rounds this is never called (the single match is started
   * directly in transitionToPlaying).
   */
  private startNextMatchOrFinalize() {
    if (!this.active || this.active.ended) return;

    const bracket = this.active.bracket;
    if (!bracket) {
      console.log("[lobby] startNextMatchOrFinalize: no bracket → finalize");
      this.finalizeRound();
      return;
    }

    console.log(
      `[lobby] startNextMatchOrFinalize: bracket matches=${bracket.matches
        .map((m) => `${m.matchId}(a=${m.a?.slice(0, 4) ?? "_"} b=${m.b?.slice(0, 4) ?? "_"} w=${m.winner?.slice(0, 4) ?? "_"})`)
        .join(",")}`,
    );

    if (isComplete(bracket)) {
      console.log("[lobby] bracket complete → finalize");
      this.finalizeRound();
      return;
    }

    const next = nextMatch(bracket);
    if (!next) {
      console.log("[lobby] no next match → finalize");
      this.finalizeRound();
      return;
    }
    console.log(`[lobby] next match: ${next.matchId}`);

    // Resolve player records for the match.
    const aRec = next.a ? this.registry.getByPlayerId(next.a) : null;
    const bRec = next.b ? this.registry.getByPlayerId(next.b) : null;

    // Disconnected participant → forfeit immediately.
    const aOk = !!aRec?.connectionId;
    const bOk = !!bRec?.connectionId;
    if (next.a && next.b && (!aOk || !bOk)) {
      const survivor = aOk ? next.a : bOk ? next.b : null;
      if (survivor) {
        recordMatchResult(bracket, next.matchId, survivor);
        this.active.matchSummaries.push(`${this.nick(survivor)} wins by forfeit`);
        this.broadcastLobbyState();
        this.startNextMatchOrFinalize();
        return;
      }
      // Both gone: skip to finalize.
      this.finalizeRound();
      return;
    }

    if (!next.a || !next.b || !aRec || !bRec) {
      // Defensive: shouldn't happen because nextMatch only returns matches
      // with both slots filled. Skip and finalize.
      this.finalizeRound();
      return;
    }

    const participants: MiniGamePlayer[] = [
      {
        playerId: aRec.playerId,
        nickname: aRec.nickname,
        avatarId: aRec.avatarId,
      },
      {
        playerId: bRec.playerId,
        nickname: bRec.nickname,
        avatarId: bRec.avatarId,
      },
    ];

    this.active.currentMatchId = next.matchId;
    this.active.currentParticipants = participants;
    this.active.intermissionUntil = null;

    this.startMatch(participants);
  }

  /** Create the mini-game session for the current match and broadcast state. */
  private startMatch(participants: MiniGamePlayer[]) {
    if (!this.active) return;
    const def = getMiniGame(this.active.minigameId);
    if (!def) {
      this.transitionToIdle();
      return;
    }

    // Broadcast the "playing" state BEFORE createSession so clients have the
    // mini-game client mounted when welcome messages arrive.
    this.broadcastLobbyState();

    const ctx: MiniGameContext = {
      players: participants,
      allPlayers: this.lobbyPlayersForMinigame(),
      broadcast: (m) => {
        const wire: MiniGameMsg = { scope: "minigame", ...m };
        this.room.broadcast(JSON.stringify(wire));
      },
      sendTo: (playerId, m) => {
        const conn = this.connectionFor(playerId);
        if (!conn) return;
        const wire: MiniGameMsg = { scope: "minigame", ...m };
        conn.send(JSON.stringify(wire));
      },
      endRound: ({ scores, summary }) =>
        this.completeMatch({ scores, summary }),
      setClickerAvailable: (_pid, _avail) => {
        // Phase 6 wires this through to the clicker subsystem; no-op for now.
      },
      log: (...args) => console.log(`[${def.id}]`, ...args),
    };

    const session = def.createSession(ctx);
    const tickHz = def.tickHz ?? 0;
    let tickHandle: ReturnType<typeof setInterval> | null = null;
    if (tickHz > 0 && session.tick) {
      tickHandle = setInterval(
        () => this.tickActive(),
        Math.max(8, Math.floor(1000 / tickHz)),
      );
    }
    this.active.session = session;
    this.active.tickHandle = tickHandle;
    this.active.lastTickAt = Date.now();
  }

  private tickActive() {
    if (!this.active || this.active.ended || !this.active.session) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.active.lastTickAt) / 1000);
    this.active.lastTickAt = now;
    this.active.session.tick?.(dt);
  }

  /** Mini-game called endRound for the current match. */
  private completeMatch(result: {
    scores: Record<string, number>;
    summary?: string;
  }) {
    if (!this.active || this.active.ended || !this.active.session) return;

    // Tear down the per-match session.
    if (this.active.tickHandle) {
      clearInterval(this.active.tickHandle);
      this.active.tickHandle = null;
    }
    this.active.session.cleanup();
    this.active.session = null;

    if (result.summary) this.active.matchSummaries.push(result.summary);

    if (this.active.format === "ffa") {
      // No bracket — these scores are the round result directly.
      this.finalizeRoundFromScores(result.scores, result.summary);
      return;
    }

    // 1v1 / bracket flow: determine the winner from per-match scores
    // (highest scorer wins; ties not expected for 1v1 first-to-N).
    const winner = pickWinner(result.scores);
    if (winner && this.active.bracket && this.active.currentMatchId) {
      recordMatchResult(this.active.bracket, this.active.currentMatchId, winner);
    }

    // Enter intermission, then start the next match.
    this.active.currentMatchId = null;
    this.active.currentParticipants = [];
    this.active.intermissionUntil = Date.now() + INTERMISSION_MS;
    this.broadcastLobbyState();

    this.active.intermissionTimer = setTimeout(() => {
      if (!this.active) return;
      this.active.intermissionTimer = null;
      this.startNextMatchOrFinalize();
    }, INTERMISSION_MS);
  }

  /** Bracket complete → derive scores from placements; finalize the round. */
  private finalizeRound() {
    if (!this.active || this.active.ended) return;
    const round = this.active;
    const scores: Record<string, number> =
      round.bracket !== null
        ? placementsToPoints(placements(round.bracket))
        : {};
    const summary =
      round.matchSummaries.length > 0
        ? round.matchSummaries[round.matchSummaries.length - 1]
        : undefined;
    this.finalizeRoundFromScores(scores, summary);
  }

  /** Common path: turn round-end scores into round-results state. */
  private finalizeRoundFromScores(
    scores: Record<string, number>,
    summary: string | undefined,
  ) {
    if (!this.active || this.active.ended) return;
    this.active.ended = true;
    if (this.active.tickHandle) {
      clearInterval(this.active.tickHandle);
      this.active.tickHandle = null;
    }
    if (this.active.intermissionTimer) {
      clearTimeout(this.active.intermissionTimer);
      this.active.intermissionTimer = null;
    }
    if (this.active.session) {
      try {
        this.active.session.cleanup();
      } catch {
        /* ignore */
      }
      this.active.session = null;
    }

    const participants =
      this.active.bracket?.participants ??
      this.active.currentParticipants.map((p) => p.playerId);

    const fullResult: RoundResult = {
      minigameId: this.active.minigameId,
      scores,
      summary,
      participants,
    };
    for (const [pid, pts] of Object.entries(scores)) {
      this.sessionScores[pid] = (this.sessionScores[pid] ?? 0) + pts;
    }
    this.lastResult = fullResult;
    this.active = null;
    this.state = "round-results";
    this.broadcastLobbyState();
    const sessionMsg: SessionStateMsg = {
      scope: "lobby",
      type: "session-state",
      scores: this.sessionScores,
    };
    this.room.broadcast(JSON.stringify(sessionMsg));

    if (this.resultsAutoDismissTimer) clearTimeout(this.resultsAutoDismissTimer);
    this.resultsAutoDismissTimer = setTimeout(
      () => this.transitionToIdle(),
      ROUND_RESULTS_AUTO_DISMISS_MS,
    );
  }

  private transitionToIdle() {
    if (this.prepareTimer) {
      clearTimeout(this.prepareTimer);
      this.prepareTimer = null;
    }
    if (this.resultsAutoDismissTimer) {
      clearTimeout(this.resultsAutoDismissTimer);
      this.resultsAutoDismissTimer = null;
    }
    if (this.active) {
      if (this.active.tickHandle) clearInterval(this.active.tickHandle);
      if (this.active.intermissionTimer) clearTimeout(this.active.intermissionTimer);
      if (this.active.session) {
        try {
          this.active.session.cleanup();
        } catch {
          /* ignore */
        }
      }
      this.active = null;
    }
    this.state = "idle";
    this.lastResult = null;
    this.broadcastLobbyState();
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private nick(playerId: string): string {
    return this.registry.getByPlayerId(playerId)?.nickname ?? "?";
  }

  private lobbyPlayersForMinigame(): MiniGamePlayer[] {
    return this.registry
      .connected()
      .map<MiniGamePlayer>((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        avatarId: p.avatarId,
      }));
  }

  private connectionFor(playerId: string): Party.Connection | null {
    const r = this.registry.getByPlayerId(playerId);
    if (!r?.connectionId) return null;
    return this.room.getConnection(r.connectionId) ?? null;
  }

  private sendCurrentLobbyState(conn: Party.Connection) {
    this.send<LobbyStateMsg>(conn, this.buildLobbyStateMsg());
  }

  private broadcastLobbyState() {
    this.room.broadcast(JSON.stringify(this.buildLobbyStateMsg()));
  }

  private buildLobbyStateMsg(): LobbyStateMsg {
    if (this.state === "preparing") {
      return {
        scope: "lobby",
        type: "state",
        state: "preparing",
        minigameId: this.prepareMinigameId,
        participants: [],
        countdownEndsAt: this.prepareUntil,
      };
    }
    if (this.state === "playing" && this.active) {
      const msg: LobbyStateMsg = {
        scope: "lobby",
        type: "state",
        state: "playing",
        minigameId: this.active.minigameId,
        participants: this.active.currentParticipants.map((p) => p.playerId),
      };
      if (this.active.bracket) {
        msg.bracket = this.toPublicBracket(
          this.active.bracket,
          this.active.currentMatchId,
        );
      }
      if (
        this.active.intermissionUntil !== null &&
        this.active.intermissionUntil > Date.now()
      ) {
        msg.intermissionUntil = this.active.intermissionUntil;
      }
      return msg;
    }
    if (this.state === "round-results" && this.lastResult) {
      return {
        scope: "lobby",
        type: "state",
        state: "round-results",
        result: this.lastResult,
      };
    }
    if (this.state === "session-results") {
      return { scope: "lobby", type: "state", state: "session-results" };
    }
    return { scope: "lobby", type: "state", state: "idle" };
  }

  private toPublicBracket(
    bracket: Bracket,
    activeMatchId: string | null,
  ): PublicBracket {
    return {
      rounds: bracket.rounds,
      matches: bracket.matches.map((m: BracketMatch) => ({
        matchId: m.matchId,
        round: m.round,
        index: m.index,
        a: m.a,
        b: m.b,
        winner: m.winner,
      })),
      activeMatchId,
    };
  }

  private broadcastPlayerList() {
    const msg: PlayerListMsg = {
      scope: "presence",
      type: "player-list",
      players: this.registry.toPublic(this.gmPlayerId),
      gmPlayerId: this.gmPlayerId,
      gmGraceUntil: this.gmGraceUntil,
    };
    this.room.broadcast(JSON.stringify(msg));
  }

  private send<T extends ServerToClient>(conn: Party.Connection, msg: T) {
    conn.send(JSON.stringify(msg));
  }
}

function pickWinner(scores: Record<string, number>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [pid, s] of Object.entries(scores)) {
    if (s > bestScore) {
      bestScore = s;
      best = pid;
    }
  }
  return best;
}

// Suppress unused-import warning when noUnusedParameters keeps PlayerRecord typed.
export type { PlayerRecord };
