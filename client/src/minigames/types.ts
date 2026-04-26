// Client-side mini-game interface. Mirrors the server's MiniGameDefinition /
// MiniGameSession split: a definition with metadata + createSession factory,
// and a session that handles incoming messages / cleans up.

export type MiniGameClientPlayer = {
  playerId: string;
  nickname: string;
  avatarId: string;
};

export type MiniGameClientContext = {
  /** DOM element to mount the mini-game's canvas/UI into. */
  container: HTMLElement;
  /** Own playerId. */
  selfPlayerId: string;
  /** Player IDs participating this round (others are spectators). */
  participants: string[];
  /** All known players in the lobby (for nickname/avatar lookup). */
  allPlayers: MiniGameClientPlayer[];
  /** Send a scope: "minigame" message to the server. */
  send: (msg: { type: string; [k: string]: unknown }) => void;
  /**
   * Push the current match score (or any short status) to the universal
   * session toolbar. Pass null to clear. The mini-game label itself is
   * already shown by the toolbar via the registered MiniGameInfo — this
   * slot is for live, mini-game-specific info such as "3 – 1".
   */
  setMatchScore: (text: string | null) => void;
};

export type MiniGameClientSession = {
  /** Server delivered a `scope: "minigame"` message — pass it to the session. */
  onMessage: (msg: { type: string; [k: string]: unknown }) => void;
  /** Called when the round ends or the player navigates away. */
  unmount: () => void;
};

export type MiniGameClientDefinition = {
  id: string;
  createSession: (ctx: MiniGameClientContext) => MiniGameClientSession;
};
