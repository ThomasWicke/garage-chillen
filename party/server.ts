// LobbyServer — one instance per lobby code. Owns identity, GM role, lobby
// state machine, and one active gamemode session per round. Keys players by
// `playerId` so refresh / lost-wifi / closed-tab all reconnect cleanly.
//
// Lobby state machine:
//   idle → preparing → playing (one gamemode session) → round-results → idle
//
// All competitive structure (brackets, parallel matches, intros) lives in
// the gamemode wrapper (party/gamemodes/). The lobby just dispatches.

import type * as Party from "partykit/server";
import { PlayerRegistry, type PlayerRecord } from "./identity";
import { allMiniGames, getMiniGame } from "./minigames";
import "./gamemodes"; // self-register tournament etc.
import { getGamemode } from "./gamemodes/registry";
import type {
  GamemodeContext,
  GamemodeSession,
  MiniGamePlayer,
} from "./gamemodes/types";
import type {
  AvailableMiniGamesMsg,
  ClientToServer,
  EditRejectedMsg,
  IdentifyMsg,
  LobbyState,
  LobbyStateMsg,
  MiniGameInfo,
  MiniGameMsg,
  PlayerListMsg,
  RoundResult,
  SequencePublicState,
  ServerToClient,
  SessionStateMsg,
  WelcomeMsg,
} from "./protocol";

const GM_GRACE_MS = 30_000;
const PREPARE_COUNTDOWN_MS = 3_000;
const ROUND_RESULTS_AUTO_DISMISS_MS = 8_000;
const ROUND_RESULTS_AUTO_DISMISS_SHUFFLE_MS = 4_000;
const SEQUENCE_AUTOSTART_MS = 7_000;

type SequenceState = {
  /** Original (full) shuffle plan; unchanged for the run. Used to compute
   *  total/index/remaining for the public state. */
  plan: string[];
  /** Index of the next mini-game to start. Advances after each scheduling. */
  cursor: number;
  paused: boolean;
  /** Set while waiting in the inter-round lobby window. */
  autoStartAt: number | null;
  autoStartTimer: ReturnType<typeof setTimeout> | null;
};

type ActiveRound = {
  minigameId: string;
  gamemodeId: string;
  session: GamemodeSession;
  tickHandle: ReturnType<typeof setInterval> | null;
  lastTickAt: number;
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
  private resultsDismissAt: number = 0;
  private sessionScores: Record<string, number> = {};
  private sequence: SequenceState | null = null;

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
          if (!this.isEditEligible()) {
            this.send<EditRejectedMsg>(sender, {
              scope: "presence",
              type: "edit-rejected",
              field: "nickname",
              reason: "not-allowed",
            });
            return;
          }
          const result = this.registry.setNicknameStrict(
            player.playerId,
            msg.nickname,
          );
          if (!result.ok) {
            this.send<EditRejectedMsg>(sender, {
              scope: "presence",
              type: "edit-rejected",
              field: "nickname",
              reason: result.reason,
            });
            return;
          }
          this.broadcastPlayerList();
          return;
        }
        case "set-avatar": {
          const player = this.registry.getByConnection(sender.id);
          if (!player) return;
          if (!this.isEditEligible()) {
            // Re-broadcast so the client reverts any optimistic update.
            this.broadcastPlayerList();
            return;
          }
          this.registry.setAvatarRotated(player.playerId, msg.avatarId);
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
        // Manual GM pick cancels any active sequence.
        this.endSequence();
        this.requestStartRound(msg.minigameId);
      } else if (msg.type === "back-to-lobby") {
        if (!isGm) return;
        this.transitionToIdle();
      } else if (msg.type === "start-shuffle") {
        if (!isGm) return;
        this.startShuffle();
      } else if (msg.type === "pause-sequence") {
        if (!isGm) return;
        this.pauseSequence();
      } else if (msg.type === "resume-sequence") {
        if (!isGm) return;
        this.resumeSequence();
      } else if (msg.type === "end-sequence") {
        if (!isGm) return;
        this.endSequence();
        this.broadcastLobbyState();
      }
      return;
    }

    if (msg.scope === "minigame") {
      if (this.state !== "playing" || !this.active?.session) return;
      const player = this.registry.getByConnection(sender.id);
      if (!player) return;
      if (msg.target === "match" && typeof msg.matchId === "string") {
        this.active.session.onMatchMessage(player.playerId, msg.matchId, msg);
      } else if (msg.target === "gamemode") {
        this.active.session.onGamemodeMessage?.(player.playerId, msg);
      }
      return;
    }
  }

  onClose(conn: Party.Connection) {
    const player = this.registry.disconnect(conn.id);
    if (!player) return;
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
        gamemode: m.gamemode,
        matchSize: m.matchSize,
        minPlayers: m.minPlayers,
        maxPlayers: m.maxPlayers,
        shuffleWeight: m.shuffleWeight ?? 1,
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
    const gm = getGamemode(def.gamemode);
    if (!gm) return;

    const lobbyPlayers = this.lobbyPlayersForMinigame();
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
    const gm = getGamemode(def.gamemode);
    if (!gm) {
      this.transitionToIdle();
      return;
    }

    const lobbyPlayers = this.lobbyPlayersForMinigame();
    if (lobbyPlayers.length < def.minPlayers) {
      this.transitionToIdle();
      return;
    }

    this.state = "playing";
    // Broadcast playing state BEFORE creating gamemode session so clients
    // have the gamemode client mounted when the gamemode emits its first
    // bracket-state / welcome messages.
    this.active = {
      minigameId: def.id,
      gamemodeId: gm.id,
      session: null as unknown as GamemodeSession, // filled below
      tickHandle: null,
      lastTickAt: 0,
      ended: false,
    };
    this.broadcastLobbyState();

    const ctx: GamemodeContext = {
      lobbyPlayers,
      miniGame: def,
      broadcastGamemode: (m) => {
        const wire: MiniGameMsg = {
          scope: "minigame",
          target: "gamemode",
          ...m,
        };
        this.room.broadcast(JSON.stringify(wire));
      },
      sendGamemode: (playerId, m) => {
        const conn = this.connectionFor(playerId);
        if (!conn) return;
        const wire: MiniGameMsg = {
          scope: "minigame",
          target: "gamemode",
          ...m,
        };
        conn.send(JSON.stringify(wire));
      },
      broadcastMatch: (matchId, recipientIds, m) => {
        const wire: MiniGameMsg = {
          scope: "minigame",
          target: "match",
          matchId,
          ...m,
        };
        const payload = JSON.stringify(wire);
        for (const pid of recipientIds) {
          const conn = this.connectionFor(pid);
          if (conn) conn.send(payload);
        }
      },
      sendMatch: (matchId, playerId, m) => {
        const conn = this.connectionFor(playerId);
        if (!conn) return;
        const wire: MiniGameMsg = {
          scope: "minigame",
          target: "match",
          matchId,
          ...m,
        };
        conn.send(JSON.stringify(wire));
      },
      endRound: ({ points, summary, participants }) =>
        this.completeRound({ points, summary, participants }),
      setClickerAvailable: (_pid, _avail) => {
        // Phase 6 wires this through; no-op for now.
      },
      log: (...args) =>
        console.log(`[${gm.id}/${def.id}]`, ...args),
    };

    const session = gm.createSession(ctx);
    this.active.session = session;

    const tickHz = Math.max(gm.tickHz, def.tickHz);
    let tickHandle: ReturnType<typeof setInterval> | null = null;
    if (tickHz > 0) {
      tickHandle = setInterval(
        () => this.tickActive(),
        Math.max(8, Math.floor(1000 / tickHz)),
      );
    }
    this.active.tickHandle = tickHandle;
    this.active.lastTickAt = Date.now();
  }

  private tickActive() {
    if (!this.active || this.active.ended) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.active.lastTickAt) / 1000);
    this.active.lastTickAt = now;
    this.active.session.tick?.(dt);
  }

  private completeRound(args: {
    points: Record<string, number>;
    summary?: string;
    participants?: string[];
  }) {
    if (!this.active || this.active.ended) return;
    this.active.ended = true;
    if (this.active.tickHandle) {
      clearInterval(this.active.tickHandle);
      this.active.tickHandle = null;
    }
    try {
      this.active.session.cleanup();
    } catch {
      /* ignore */
    }

    const fullResult: RoundResult = {
      minigameId: this.active.minigameId,
      scores: args.points,
      summary: args.summary,
      participants:
        args.participants ?? Object.keys(args.points),
    };
    for (const [pid, pts] of Object.entries(args.points)) {
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
    const dismissMs = this.sequence
      ? ROUND_RESULTS_AUTO_DISMISS_SHUFFLE_MS
      : ROUND_RESULTS_AUTO_DISMISS_MS;
    this.resultsDismissAt = Date.now() + dismissMs;
    // Re-broadcast lobby state now that dismissAt is known (the broadcast
    // before this point ran without it because we set the timestamp here).
    this.broadcastLobbyState();
    this.resultsAutoDismissTimer = setTimeout(
      () => this.transitionToIdle(),
      dismissMs,
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
      try {
        this.active.session.cleanup();
      } catch {
        /* ignore */
      }
      this.active = null;
    }
    this.state = "idle";
    this.lastResult = null;
    this.broadcastLobbyState();
    // If a shuffle sequence is active, kick off the inter-round countdown.
    if (this.sequence && !this.sequence.paused) {
      this.scheduleNextInSequence();
    }
  }

  // ─── shuffle sequence ────────────────────────────────────────────────────

  private startShuffle() {
    if (this.state !== "idle") return;
    if (this.sequence) return; // already running
    const lobbyN = this.lobbyPlayersForMinigame().length;
    const eligible = allMiniGames().filter(
      (m) => m.minPlayers <= lobbyN && lobbyN <= m.maxPlayers,
    );
    if (eligible.length === 0) return;

    const pool: string[] = [];
    for (const m of eligible) {
      const w = Math.max(1, m.shuffleWeight ?? 1);
      for (let i = 0; i < w; i++) pool.push(m.id);
    }
    shuffleInPlace(pool);

    this.sequence = {
      plan: pool,
      cursor: 0,
      paused: false,
      autoStartAt: null,
      autoStartTimer: null,
    };
    // Start the first game right away (no intro countdown for the very first
    // game; the per-mini-game preparing countdown still plays).
    this.advanceSequence();
  }

  private advanceSequence() {
    if (!this.sequence || this.sequence.paused) return;
    const lobbyN = this.lobbyPlayersForMinigame().length;
    while (this.sequence.cursor < this.sequence.plan.length) {
      const id = this.sequence.plan[this.sequence.cursor];
      const def = getMiniGame(id);
      this.sequence.cursor++;
      if (
        def &&
        def.minPlayers <= lobbyN &&
        lobbyN <= def.maxPlayers
      ) {
        this.requestStartRound(id);
        return;
      }
      // Otherwise: skip and try the next.
    }
    // Queue exhausted.
    this.endSequence();
    this.broadcastLobbyState();
  }

  private scheduleNextInSequence() {
    if (!this.sequence || this.sequence.paused) return;
    if (this.sequence.cursor >= this.sequence.plan.length) {
      // No more games — finish the run.
      this.endSequence();
      this.broadcastLobbyState();
      return;
    }
    if (this.sequence.autoStartTimer) {
      clearTimeout(this.sequence.autoStartTimer);
    }
    this.sequence.autoStartAt = Date.now() + SEQUENCE_AUTOSTART_MS;
    this.sequence.autoStartTimer = setTimeout(() => {
      if (!this.sequence) return;
      this.sequence.autoStartTimer = null;
      this.sequence.autoStartAt = null;
      this.advanceSequence();
    }, SEQUENCE_AUTOSTART_MS);
    this.broadcastLobbyState();
  }

  private pauseSequence() {
    if (!this.sequence) return;
    if (this.sequence.paused) return;
    this.sequence.paused = true;
    if (this.sequence.autoStartTimer) {
      clearTimeout(this.sequence.autoStartTimer);
      this.sequence.autoStartTimer = null;
    }
    this.sequence.autoStartAt = null;
    this.broadcastLobbyState();
  }

  private resumeSequence() {
    if (!this.sequence) return;
    if (!this.sequence.paused) return;
    this.sequence.paused = false;
    // If we're sitting in idle waiting between games, restart the countdown.
    if (this.state === "idle") {
      this.scheduleNextInSequence();
    } else {
      this.broadcastLobbyState();
    }
  }

  private endSequence() {
    if (!this.sequence) return;
    if (this.sequence.autoStartTimer) {
      clearTimeout(this.sequence.autoStartTimer);
    }
    this.sequence = null;
  }

  private buildSequencePublic(): SequencePublicState | undefined {
    if (!this.sequence) return undefined;
    const remaining = this.sequence.plan.length - this.sequence.cursor;
    const nextId =
      this.sequence.cursor < this.sequence.plan.length
        ? this.sequence.plan[this.sequence.cursor]
        : null;
    return {
      total: this.sequence.plan.length,
      // Public index = number of completed rounds (= cursor when between rounds,
      // = cursor-1 while a round is running). The currently-running game has
      // already been pulled off the queue, so cursor points to the NEXT slot.
      // We expose `index` = (total - remaining) which the client can use directly.
      index: this.sequence.cursor - 1 < 0 ? 0 : this.sequence.cursor - 1,
      remaining,
      nextMinigameId: nextId,
      paused: this.sequence.paused,
      autoStartAt: this.sequence.autoStartAt,
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  /**
   * Player edits to nickname/avatar are accepted only when the lobby is in
   * a "calm" state: idle (no active round), and either no shuffle sequence
   * is running or it is paused.
   */
  private isEditEligible(): boolean {
    if (this.state !== "idle") return false;
    if (!this.sequence) return true;
    return this.sequence.paused;
  }

  private lobbyPlayersForMinigame(): MiniGamePlayer[] {
    return this.registry.connected().map<MiniGamePlayer>((p) => ({
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
    const sequence = this.buildSequencePublic();
    if (this.state === "preparing") {
      return {
        scope: "lobby",
        type: "state",
        state: "preparing",
        minigameId: this.prepareMinigameId,
        countdownEndsAt: this.prepareUntil,
        ...(sequence ? { sequence } : {}),
      };
    }
    if (this.state === "playing" && this.active) {
      return {
        scope: "lobby",
        type: "state",
        state: "playing",
        minigameId: this.active.minigameId,
        gamemodeId: this.active.gamemodeId,
        ...(sequence ? { sequence } : {}),
      };
    }
    if (this.state === "round-results" && this.lastResult) {
      return {
        scope: "lobby",
        type: "state",
        state: "round-results",
        result: this.lastResult,
        dismissAt: this.resultsDismissAt,
        ...(sequence ? { sequence } : {}),
      };
    }
    if (this.state === "session-results") {
      return {
        scope: "lobby",
        type: "state",
        state: "session-results",
        ...(sequence ? { sequence } : {}),
      };
    }
    return {
      scope: "lobby",
      type: "state",
      state: "idle",
      ...(sequence ? { sequence } : {}),
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

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Suppress unused-import warning when noUnusedParameters keeps PlayerRecord typed.
export type { PlayerRecord };
