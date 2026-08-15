// Wire protocol shared between client and server.
// Every message has a `scope`. Gamemode + match traffic share `scope: "minigame"`
// disambiguated by `target`:
//   • target: "gamemode" — gamemode-level (bracket-state, round-intro, etc.)
//   • target: "match" + matchId — per-match traffic (welcome, state, fire…)
// The server forwards both opaquely; the client routes by target/matchId.

export type LobbyState =
  | "idle"
  | "preparing"
  | "playing"
  | "round-results"
  | "session-results";

export type PublicPlayer = {
  playerId: string;
  nickname: string;
  avatarId: string;
  connected: boolean;
  isGm: boolean;
  /** Set for server-side test bots (test lobbies only): the bot's current
   *  input strategy. */
  bot?: BotStrategy;
};

// ─── test lobbies ──────────────────────────────────────────────────────────
//
// A lobby whose code starts with "TEST" is a test lobby: the GM can add
// server-side bots and toggle fast waits from a debug panel. Everything
// else behaves exactly like a normal lobby.

export function isTestLobbyCode(code: string): boolean {
  return /^test/i.test(code);
}

/**
 * How a test bot produces inputs. Bots have no per-game AI: they re-inject
 * the human players' match messages under their own playerId.
 *   mirror — every human match message, ~250ms later (a perfect shadow)
 *   sloppy — ~70% of messages, 150–700ms later (falls behind, dies at
 *            different times → exercises staggered placements)
 *   idle   — sends nothing (the "player who does nothing" case)
 */
export type BotStrategy = "mirror" | "sloppy" | "idle";

export const BOT_STRATEGIES: readonly BotStrategy[] = ["mirror", "sloppy", "idle"];

/** GM → server debug controls (test lobbies only; ignored elsewhere). */
export type TestControlMsg = {
  scope: "lobby";
  type: "test";
} & (
  | { action: "add-bot" }
  | { action: "remove-bot"; playerId?: string }
  | { action: "set-bot-strategy"; playerId: string; strategy: BotStrategy }
  | { action: "set-fast"; fast: boolean }
);

/** Server → client: test-lobby status. Sent on identify and on change. */
export type TestStateMsg = {
  scope: "lobby";
  type: "test-state";
  enabled: boolean;
  /** Fast mode: shorter intro / between / results waits, and tournament
   *  matches between two bots auto-resolve instead of playing out. */
  fast: boolean;
};

export type RoundResult = {
  minigameId: string;
  /** Per-player points contributed to the session aggregate this round. */
  scores: Record<string, number>;
  /** Optional human-readable summary the gamemode wants displayed. */
  summary?: string;
  /** Player IDs who actually participated (others were spectators). */
  participants: string[];
};

// ─── presence ──────────────────────────────────────────────────────────────

export type IdentifyMsg = {
  scope: "presence";
  type: "identify";
  playerId: string;
  nickname: string;
  avatarId: string;
};

export type WelcomeMsg = {
  scope: "presence";
  type: "welcome";
  selfPlayerId: string;
  lobbyCode: string;
};

export type PlayerListMsg = {
  scope: "presence";
  type: "player-list";
  players: PublicPlayer[];
  gmPlayerId: string | null;
  gmGraceUntil: number | null;
};

export type SetNicknameMsg = {
  scope: "presence";
  type: "set-nickname";
  nickname: string;
};

export type SetAvatarMsg = {
  scope: "presence";
  type: "set-avatar";
  avatarId: string;
};

/**
 * Server → client rejection of an in-lobby edit (set-nickname / set-avatar).
 * Used when the requested change conflicts with another player or fails the
 * editability gate. The client is responsible for reverting any optimistic
 * UI and surfacing the reason.
 */
export type EditRejectedMsg = {
  scope: "presence";
  type: "edit-rejected";
  field: "nickname" | "avatar";
  reason: "duplicate" | "invalid" | "not-allowed";
};

// ─── lobby ─────────────────────────────────────────────────────────────────

/** Static metadata about a mini-game, shared with the client for the GM picker. */
export type MiniGameInfo = {
  id: string;
  displayName: string;
  gamemode: "tournament" | "last-man-standing";
  matchSize: number;
  minPlayers: number;
  maxPlayers: number;
  shuffleWeight: number;
  /** Archived games are pickable from the picker's Archive tab but are
   *  excluded from Shuffle runs. */
  archived: boolean;
};

export type AvailableMiniGamesMsg = {
  scope: "lobby";
  type: "available-minigames";
  minigames: MiniGameInfo[];
};

export type SessionStateMsg = {
  scope: "lobby";
  type: "session-state";
  /** Cumulative session points per playerId. Persists across rounds, resets
   *  only when the GM ends the session (Phase 5). */
  scores: Record<string, number>;
};

/** Public sequence (Shuffle) progress, attached to all lobby states while a
 *  shuffle sequence is active. */
export type SequencePublicState = {
  /** Total games originally queued. */
  total: number;
  /** Index of the currently-running / just-completed game (0-based). */
  index: number;
  /** Number of games still remaining (including currently running). */
  remaining: number;
  /** Mini-game ID about to start next; null when the queue is empty. */
  nextMinigameId: string | null;
  /** Whether the GM has paused the sequence. */
  paused: boolean;
  /** Server time when the next round will auto-start (lobby idle countdown).
   *  Null while not in the inter-round window or while paused. */
  autoStartAt: number | null;
};

type LobbyStateBase = {
  scope: "lobby";
  type: "state";
  /** Present while a shuffle sequence is running. */
  sequence?: SequencePublicState;
};

export type LobbyStateMsg = LobbyStateBase &
  (
    | { state: "idle" }
    | {
        state: "preparing";
        minigameId: string;
        countdownEndsAt: number;
      }
    | {
        state: "playing";
        minigameId: string;
        gamemodeId: string;
      }
    | {
        state: "round-results";
        result: RoundResult;
        /** Server time when round-results auto-dismisses to idle. */
        dismissAt: number;
      }
    | {
        state: "session-results";
        /** Server time when the finale auto-dismisses to idle. */
        dismissAt: number;
      }
  );

export type StartRoundMsg = {
  scope: "lobby";
  type: "start-round";
  minigameId: string;
};

export type BackToLobbyMsg = {
  scope: "lobby";
  type: "back-to-lobby";
};

export type StartShuffleMsg = {
  scope: "lobby";
  type: "start-shuffle";
};

export type PauseSequenceMsg = {
  scope: "lobby";
  type: "pause-sequence";
};

export type ResumeSequenceMsg = {
  scope: "lobby";
  type: "resume-sequence";
};

export type EndSequenceMsg = {
  scope: "lobby";
  type: "end-sequence";
};

// ─── minigame (gamemode + match traffic; opaque pass-through) ─────────────

/**
 * scope:"minigame" — both gamemode-level and per-match messages.
 *   target = "gamemode"  → handled by the active gamemode session.
 *   target = "match"     → routed by `matchId` to a specific match session.
 * If `target` is omitted, server defaults to "match" for backwards-compat
 * with simpler mini-games (but the new flow always sets target explicitly).
 */
export type MiniGameMsg = {
  scope: "minigame";
  target: "gamemode" | "match";
  matchId?: string;
  type: string;
  [key: string]: unknown;
};

// ─── union ─────────────────────────────────────────────────────────────────

export type ClientToServer =
  | IdentifyMsg
  | SetNicknameMsg
  | SetAvatarMsg
  | StartRoundMsg
  | BackToLobbyMsg
  | StartShuffleMsg
  | PauseSequenceMsg
  | ResumeSequenceMsg
  | EndSequenceMsg
  | TestControlMsg
  | MiniGameMsg;

export type ServerToClient =
  | WelcomeMsg
  | PlayerListMsg
  | EditRejectedMsg
  | AvailableMiniGamesMsg
  | SessionStateMsg
  | TestStateMsg
  | LobbyStateMsg
  | MiniGameMsg;
