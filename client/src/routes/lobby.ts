// Lobby route — owns the WebSocket connection for the lifetime of the route
// and re-renders the DOM lobby view on every server message.

import { ensureIdentity } from "../identity";
import { LobbyConnection, type ConnectionStatus } from "../socket";
import { renderLobbyView, type LobbyViewState } from "../ui/lobby-view";
import type {
  LobbyState,
  PublicPlayer,
  ServerToClient,
} from "../../../party/protocol";

export function renderLobby(rawCode: string): () => void {
  const code = rawCode.toUpperCase();
  const identity = ensureIdentity();
  const app = document.getElementById("app")!;

  const state: LobbyViewState = {
    code,
    status: "connecting",
    selfPlayerId: null,
    players: [] as PublicPlayer[],
    gmPlayerId: null,
    gmGraceUntil: null,
    lobbyState: "idle" as LobbyState,
  };

  const rerender = () => renderLobbyView(state, app);
  rerender();

  const conn = new LobbyConnection(code.toLowerCase(), identity, {
    onStatus: (status: ConnectionStatus) => {
      state.status = status;
      rerender();
    },
    onMessage: (msg: ServerToClient) => {
      if (msg.scope === "presence" && msg.type === "welcome") {
        state.selfPlayerId = msg.selfPlayerId;
      } else if (msg.scope === "presence" && msg.type === "player-list") {
        state.players = msg.players;
        state.gmPlayerId = msg.gmPlayerId;
        state.gmGraceUntil = msg.gmGraceUntil;
      } else if (msg.scope === "lobby" && msg.type === "state") {
        state.lobbyState = msg.state;
      }
      rerender();
    },
  });

  // Tick the rerender once a second while the GM is in grace, so the countdown
  // ticks down even without server messages.
  const interval = setInterval(() => {
    if (state.gmGraceUntil !== null && state.gmGraceUntil > Date.now()) {
      rerender();
    }
  }, 1000);

  return () => {
    clearInterval(interval);
    conn.close();
  };
}
