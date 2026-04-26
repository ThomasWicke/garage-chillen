// MiniGame interface (server-side). Each mini-game is a `MiniGameDefinition`
// with static metadata + a `createSession(ctx)` factory. The lobby instantiates
// one session per round and tears it down on round-end.
//
// Adding a new mini-game = drop a new module pair (server + client) into
// minigames/<id>/, register it in minigames/index.ts.

import type { MiniGameInfo } from "../protocol";

export type MiniGamePlayer = {
  playerId: string;
  nickname: string;
  avatarId: string;
};

export type MiniGameContext = {
  /** Players participating in this match (subset of the lobby). For 1v1
   *  mini-games run through the bracket layer this is exactly 2; for FFA
   *  mini-games it's whatever the mini-game's pickParticipants returned. */
  players: MiniGamePlayer[];
  /** All connected lobby players, including spectators. Mini-games use this
   *  to send role: "spectator" welcomes to non-participants. */
  allPlayers: MiniGamePlayer[];
  /** Broadcast a `scope: "minigame"` message to all connections in the lobby. */
  broadcast: (msg: { type: string; [k: string]: unknown }) => void;
  /** Send a `scope: "minigame"` message to one player. */
  sendTo: (playerId: string, msg: { type: string; [k: string]: unknown }) => void;
  /**
   * Signal that this round is over. `scores` is a map of playerId → points
   * contributed to the session aggregate. Mini-games can include any subset of
   * lobby players (e.g. only participants).
   */
  endRound: (args: {
    scores: Record<string, number>;
    summary?: string;
  }) => void;
  /**
   * Per-player ADHD-King clicker availability override. Defaults to false
   * during a round; mini-games turn it on for byes/spectators/quiz-waiting,
   * off for actively-playing participants.
   */
  setClickerAvailable: (playerId: string, available: boolean) => void;
  log: (...args: unknown[]) => void;
};

export type MiniGameSession = {
  /** Run periodically at `tickHz` (omit for event-driven mini-games). */
  tick?: (dtSeconds: number) => void;
  /** Handle a `scope: "minigame"` message from a participant. */
  onMessage: (playerId: string, msg: { type: string; [k: string]: unknown }) => void;
  /** Player disconnected mid-round; mini-game decides how to react. */
  onPlayerLeft?: (playerId: string) => void;
  /** Lobby is tearing down the round; release any timers/resources. */
  cleanup: () => void;
};

export type MiniGameDefinition = MiniGameInfo & {
  orientation: "portrait";
  tickHz?: number;
  /**
   * Decide if this mini-game can run with the given lobby player count.
   * Default: lobby N must satisfy minPlayers ≤ N ≤ maxPlayers. 1v1 mini-games
   * with N>2 are picked up by the bracket layer (Phase 3) — for Phase 2 the
   * lobby gates on N exactly equal to participants.length.
   */
  canRun?: (lobbySize: number) => boolean;
  /**
   * Pick which lobby players actually participate this round. The lobby
   * delegates this so mini-games own their format (1v1, FFA, etc.). For
   * format: "1v1" with N>2, Phase 2 returns [] which the lobby treats as
   * unrunnable (pre-bracket).
   */
  pickParticipants: (lobbyPlayers: MiniGamePlayer[]) => MiniGamePlayer[];
  createSession: (ctx: MiniGameContext) => MiniGameSession;
};
