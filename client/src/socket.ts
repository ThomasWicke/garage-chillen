// Thin wrapper around PartySocket. Exposes typed send/recv that matches the
// server's protocol, and an event system for message dispatch. Auto-sends
// `identify` on every (re-)open so reconnects restore identity automatically.

import PartySocket from "partysocket";
import type {
  ClientToServer,
  ServerToClient,
} from "../../party/protocol";
import type { Identity } from "./identity";

export type ConnectionStatus = "connecting" | "open" | "closed";

export type Handlers = {
  onMessage: (msg: ServerToClient) => void;
  onStatus: (status: ConnectionStatus) => void;
};

export class LobbyConnection {
  private socket: PartySocket;

  constructor(
    private code: string,
    private identity: Identity,
    private handlers: Handlers,
  ) {
    this.handlers.onStatus("connecting");
    this.socket = new PartySocket({
      host:
        import.meta.env.VITE_PARTYKIT_HOST ||
        `${window.location.hostname}:1999`,
      room: this.code,
    });

    this.socket.addEventListener("open", () => {
      this.handlers.onStatus("open");
      // Identify on every (re-)connect.
      this.send({
        scope: "presence",
        type: "identify",
        playerId: this.identity.playerId,
        nickname: this.identity.nickname,
        avatarId: this.identity.avatarId,
      });
    });

    this.socket.addEventListener("close", () => {
      this.handlers.onStatus("closed");
    });

    this.socket.addEventListener("message", (e) => {
      let msg: ServerToClient;
      try {
        msg = JSON.parse(e.data) as ServerToClient;
      } catch {
        return;
      }
      this.handlers.onMessage(msg);
    });
  }

  updateIdentity(identity: Identity) {
    this.identity = identity;
  }

  send(msg: ClientToServer): void {
    this.socket.send(JSON.stringify(msg));
  }

  close(): void {
    this.socket.close();
  }
}
