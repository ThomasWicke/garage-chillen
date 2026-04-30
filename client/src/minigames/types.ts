// Mini-game client interface. Mirrors the server: a definition with metadata
// + a createMatch factory. The gamemode client mounts a match client when a
// match is active for the local player; the match client handles only its
// own match's traffic (welcome, state, fire, etc.).

export type MiniGameClientPlayer = {
  playerId: string;
  nickname: string;
  avatarId: string;
};

export type MatchClientContext = {
  /** DOM element to mount the match's canvas/UI into. */
  container: HTMLElement;
  /** Unique id of this specific match. */
  matchId: string;
  /** Own playerId. */
  selfPlayerId: string;
  /** Match participants (matchSize of them). */
  participants: MiniGameClientPlayer[];
  /** Send a `scope: "minigame"` match-targeted message, automatically tagged
   *  with `target: "match"` and this matchId by the gamemode wrapper. */
  send: (msg: { type: string; [k: string]: unknown }) => void;
  /** Push current match score to the universal session toolbar. Pass null to clear. */
  setMatchScore: (text: string | null) => void;
};

export type MatchClientSession = {
  /** Server delivered a match-targeted minigame msg with this matchId. */
  onMessage: (msg: { type: string; [k: string]: unknown }) => void;
  /** Match ended or local player navigated away. */
  unmount: () => void;
};

export type MiniGameClientDefinition = {
  id: string;
  createMatch: (ctx: MatchClientContext) => MatchClientSession;
};
