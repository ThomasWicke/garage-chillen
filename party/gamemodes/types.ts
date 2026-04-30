// Gamemode interface (server). A gamemode wraps a mini-game's per-match
// logic with competitive structure: tournament brackets, last-man-standing
// elimination, free-for-all rankings, etc. Gamemodes are pluggable so a
// single mini-game module can be played in different gamemodes if needed.
//
// One LobbyServer round = one GamemodeSession. The gamemode owns the bracket /
// elimination state, schedules matches in parallel where appropriate, drives
// between-phase transitions, and reports per-player session points to the
// lobby when the round is done.

import type {
  MatchEndResult,
  MiniGameDefinition,
  MiniGamePlayer,
} from "../minigames/types";

export type { MiniGamePlayer, MatchEndResult };

export type GamemodeContext = {
  /** Lobby players at gamemode start. The gamemode tracks disconnects via
   *  onPlayerLeft. */
  lobbyPlayers: MiniGamePlayer[];
  /** The mini-game whose match logic is wrapped by this gamemode session. */
  miniGame: MiniGameDefinition;
  /** Broadcast a gamemode-level wire message to the entire lobby. The lobby
   *  layer tags it with `target: "gamemode"` on the wire. */
  broadcastGamemode: (msg: { type: string; [k: string]: unknown }) => void;
  /** Send a gamemode-level message to one player. */
  sendGamemode: (
    playerId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** Broadcast a match-level message tagged with `matchId`. Recipients are
   *  the players the gamemode wants to inform (typically: match participants
   *  + spectators if the gamemode supports spectating). */
  broadcastMatch: (
    matchId: string,
    recipientIds: string[],
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** Send a match-level message to one player. */
  sendMatch: (
    matchId: string,
    playerId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** End the gamemode session (one lobby round). Per-player session points
   *  are added to the lobby's running session aggregate. */
  endRound: (args: {
    points: Record<string, number>;
    summary?: string;
    /** Player IDs who actually participated (informational). */
    participants?: string[];
  }) => void;
  /** Per-player ADHD-King clicker availability. Defaults are managed by the
   *  lobby; gamemodes flip these per phase (e.g. on for byes/waiting players,
   *  off for actively-playing). */
  setClickerAvailable: (playerId: string, available: boolean) => void;
  log: (...args: unknown[]) => void;
};

export type GamemodeSession = {
  /** Run periodically at the gamemode's tickHz. */
  tick?: (dtSeconds: number) => void;
  /** Match-targeted client message — the gamemode routes it to the right
   *  match session by `matchId`. */
  onMatchMessage: (
    playerId: string,
    matchId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** Gamemode-level client message (e.g. "I'm ready"). Default: ignored. */
  onGamemodeMessage?: (
    playerId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  onPlayerLeft?: (playerId: string) => void;
  cleanup: () => void;
};

export type GamemodeDefinition = {
  id: string;
  displayName: string;
  /** Tick rate the gamemode wants the lobby to drive it at. */
  tickHz: number;
  createSession: (ctx: GamemodeContext) => GamemodeSession;
};
