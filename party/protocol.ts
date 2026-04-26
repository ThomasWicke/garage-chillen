// Wire protocol shared between client and server.
// Every message has a `scope` so mini-game messages cannot collide with
// lobby/presence/clicker messages. The lobby server forwards `scope: "minigame"`
// messages opaquely to the active mini-game module.

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
};

export type RoundResult = {
  minigameId: string;
  /** Per-player points contributed to the session aggregate this round. */
  scores: Record<string, number>;
  /** Optional human-readable summary the mini-game wants displayed. */
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

// ─── lobby ─────────────────────────────────────────────────────────────────

/** Static metadata about a mini-game, shared with the client for the GM picker. */
export type MiniGameInfo = {
  id: string;
  displayName: string;
  minPlayers: number;
  maxPlayers: number;
  format: "1v1" | "ffa";
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

/** Public bracket snapshot — included with "playing" lobby states for 1v1
 *  mini-games that have a bracket layer wrapped around them. */
export type PublicBracket = {
  rounds: number;
  /** All matches in the bracket, ordered by round then by match index. */
  matches: {
    matchId: string;
    round: number;
    index: number;
    a: string | null;
    b: string | null;
    winner: string | null;
  }[];
  /** matchId currently being played, or null between matches / before start. */
  activeMatchId: string | null;
};

export type LobbyStateMsg =
  | { scope: "lobby"; type: "state"; state: "idle" }
  | {
      scope: "lobby";
      type: "state";
      state: "preparing";
      minigameId: string;
      participants: string[];
      countdownEndsAt: number;
    }
  | {
      scope: "lobby";
      type: "state";
      state: "playing";
      minigameId: string;
      participants: string[]; // current match's participants
      bracket?: PublicBracket;
      /** Brief intermission between bracket matches (server timestamp);
       *  while > Date.now(), no match is active. */
      intermissionUntil?: number;
    }
  | {
      scope: "lobby";
      type: "state";
      state: "round-results";
      result: RoundResult;
    }
  | {
      scope: "lobby";
      type: "state";
      state: "session-results";
      // Phase 5 — placeholder.
    };

export type StartRoundMsg = {
  scope: "lobby";
  type: "start-round";
  minigameId: string;
};

export type BackToLobbyMsg = {
  scope: "lobby";
  type: "back-to-lobby";
};

// ─── minigame (opaque pass-through) ────────────────────────────────────────

export type MiniGameMsg = {
  scope: "minigame";
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
  | MiniGameMsg;

export type ServerToClient =
  | WelcomeMsg
  | PlayerListMsg
  | AvailableMiniGamesMsg
  | SessionStateMsg
  | LobbyStateMsg
  | MiniGameMsg;
