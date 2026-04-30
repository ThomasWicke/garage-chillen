// Gamemode client interface. The gamemode client owns the scene region for
// the duration of a round: it renders bracket overlays / intros / between-
// round screens, and mounts a match client when a match is active for the
// local player.

import type {
  MiniGameClientDefinition,
  MiniGameClientPlayer,
} from "../minigames/types";

export type GamemodeClientContext = {
  /** DOM element the gamemode owns for the duration of the round. */
  container: HTMLElement;
  /** Own playerId. */
  selfPlayerId: string;
  /** Lobby players at gamemode start. */
  lobbyPlayers: MiniGameClientPlayer[];
  /** The mini-game definition (so the gamemode can create match clients). */
  miniGame: MiniGameClientDefinition;
  /** Display name of the mini-game (for UI). */
  miniGameDisplayName: string;
  /** Send a gamemode-level message (target: "gamemode"). */
  sendGamemode: (msg: { type: string; [k: string]: unknown }) => void;
  /** Send a match-level message (target: "match", matchId tagged by caller). */
  sendMatch: (matchId: string, msg: { type: string; [k: string]: unknown }) => void;
  /** Push match score / status to the universal toolbar. */
  setMatchScore: (text: string | null) => void;
};

export type GamemodeClientSession = {
  /** Incoming gamemode-level message. */
  onGamemodeMessage: (msg: { type: string; [k: string]: unknown }) => void;
  /** Incoming match-level message (already filtered to a known matchId). */
  onMatchMessage: (
    matchId: string,
    msg: { type: string; [k: string]: unknown },
  ) => void;
  /** Round ended; gamemode client should tear down. */
  unmount: () => void;
};

export type GamemodeClientDefinition = {
  id: string;
  createSession: (ctx: GamemodeClientContext) => GamemodeClientSession;
};
