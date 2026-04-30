// Mini-game interface (server). A mini-game in this codebase is the per-match
// unit: given matchSize players and a deadline, run physics and declare a
// winner. Brackets, parallel matches, intros, and between-round transitions
// are NOT a mini-game's concern — they live in the gamemode wrapper
// (see ../gamemodes/).
//
// Adding a new mini-game = drop a new module pair (server + client) into
// minigames/<id>/, declare its `gamemode`, and provide createMatch.

export type MiniGamePlayer = {
  playerId: string;
  nickname: string;
  avatarId: string;
};

export type MatchEndResult = {
  /** Winner of the match. null = draw / no winner (gamemode resolves
   *  arbitrarily, or for FFA games like LMS this is the rank-1 player from
   *  `placements`). */
  winnerId: string | null;
  /** Optional final scores for display in round-results. */
  scores?: Record<string, number>;
  /** Optional explicit per-player placement (1 = best). FFA gamemodes
   *  (last-man-standing, free-for-all) read this; tournament uses winnerId. */
  placements?: Record<string, number>;
  /** Optional human-readable summary. */
  summary?: string;
};

export type MatchContext = {
  /** Unique id for this match (assigned by the gamemode). */
  matchId: string;
  /** Exactly matchSize participants. */
  players: MiniGamePlayer[];
  /** Server-time absolute deadline (ms). The match SHOULD end gracefully by
   *  this time (e.g. "leader-wins on timeout"); past it, the gamemode force-
   *  ends the match. Mini-games can use this for an on-screen clock. */
  deadlineAt: number;
  /** Broadcast a match-level message to this match's participants. The
   *  gamemode tags it with matchId before sending on the wire. */
  broadcast: (msg: { type: string; [k: string]: unknown }) => void;
  /** Send a match-level message to one of this match's participants. */
  sendTo: (
    playerId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** End the match. Idempotent — only the first call is honored. */
  endMatch: (result: MatchEndResult) => void;
  log: (...args: unknown[]) => void;
};

export type MatchSession = {
  /** Run periodically at the gamemode's tickHz. */
  tick?: (dtSeconds: number) => void;
  /** Match-targeted message from a participant. */
  onMessage: (
    playerId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** Participant disconnected mid-match. The gamemode forfeits them; this
   *  hook lets the match clean up its own state if needed. */
  onPlayerLeft?: (playerId: string) => void;
  /** Gamemode is tearing down the match; release any timers/resources. */
  cleanup: () => void;
};

export type SupportedGamemode = "tournament" | "last-man-standing";

export type MiniGameDefinition = {
  id: string;
  displayName: string;
  /** Which gamemode wraps this mini-game's matches. */
  gamemode: SupportedGamemode;
  /** Players per match. 2 for 1v1. */
  matchSize: number;
  /** Min lobby size to play this mini-game (e.g. 2). */
  minPlayers: number;
  /** Max lobby size. */
  maxPlayers: number;
  orientation: "portrait";
  /** Tick rate the match expects (gamemode runs at this rate). */
  tickHz: number;
  /** Hard timeout per match in ms. The match should self-end by deadlineAt;
   *  past `deadlineAt + grace`, the gamemode force-ends with a draw. */
  matchTimeoutMs: number;
  /** How many copies of this mini-game to put in the shuffle pool. Higher
   *  number = appears more often when the GM clicks Shuffle. Quick games
   *  should be 3-5; long games 1-2. Default: 1. */
  shuffleWeight?: number;
  createMatch: (ctx: MatchContext) => MatchSession;
};
