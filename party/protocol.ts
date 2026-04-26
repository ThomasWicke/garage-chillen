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
  gmGraceUntil: number | null; // epoch ms; non-null while GM is in grace period
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

export type LobbyStateMsg = {
  scope: "lobby";
  type: "state";
  state: LobbyState;
  // populated when state === "round-results" or "session-results"
  // (Phase 1: unused; placeholder for later phases)
  payload?: unknown;
};

// ─── union ─────────────────────────────────────────────────────────────────

export type ClientToServer = IdentifyMsg | SetNicknameMsg | SetAvatarMsg;
export type ServerToClient = WelcomeMsg | PlayerListMsg | LobbyStateMsg;
