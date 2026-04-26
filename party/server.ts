// LobbyServer — one instance per lobby code. Owns identity, GM role, and
// (in later phases) the active mini-game module + session aggregate score.
// Keys players by `playerId` so refresh / lost-wifi / closed-tab all reconnect
// cleanly to the same slot.

import type * as Party from "partykit/server";
import { PlayerRegistry } from "./identity";
import type {
  ClientToServer,
  IdentifyMsg,
  LobbyState,
  PlayerListMsg,
  ServerToClient,
  WelcomeMsg,
  LobbyStateMsg,
} from "./protocol";

const GM_GRACE_MS = 30_000;

export default class LobbyServer implements Party.Server {
  private registry = new PlayerRegistry();
  private gmPlayerId: string | null = null;
  private gmGraceUntil: number | null = null;
  private gmGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private state: LobbyState = "idle";

  constructor(readonly room: Party.Room) {}

  onConnect(_conn: Party.Connection) {
    // The client sends `identify` immediately on open; we wait for that
    // before adding them to the registry (we don't trust connection-id alone).
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw) as ClientToServer;
    } catch {
      return;
    }
    if (!msg || msg.scope !== "presence") return;

    switch (msg.type) {
      case "identify":
        return this.handleIdentify(msg, sender);
      case "set-nickname": {
        const player = this.registry.getByConnection(sender.id);
        if (!player) return;
        this.registry.setNickname(player.playerId, msg.nickname);
        this.broadcastPlayerList();
        return;
      }
      case "set-avatar": {
        const player = this.registry.getByConnection(sender.id);
        if (!player) return;
        this.registry.setAvatar(player.playerId, msg.avatarId);
        this.broadcastPlayerList();
        return;
      }
    }
  }

  onClose(conn: Party.Connection) {
    const player = this.registry.disconnect(conn.id);
    if (!player) return;

    // GM left → enter grace period; auto-promote longest-connected after timeout.
    if (player.playerId === this.gmPlayerId) {
      this.startGmGrace();
    }
    this.broadcastPlayerList();
  }

  // ─── handlers ────────────────────────────────────────────────────────────

  private handleIdentify(msg: IdentifyMsg, sender: Party.Connection) {
    if (!msg.playerId || typeof msg.playerId !== "string") return;

    const { record, isNew } = this.registry.upsert({
      playerId: msg.playerId,
      nickname: msg.nickname || "anon",
      avatarId: msg.avatarId || "bean",
      connectionId: sender.id,
    });

    // First identify in this lobby → assign GM if no one else has it.
    if (this.gmPlayerId === null) {
      this.gmPlayerId = record.playerId;
    } else if (record.playerId === this.gmPlayerId) {
      // Original GM came back during grace → reclaim.
      this.cancelGmGrace();
    }

    this.send<WelcomeMsg>(sender, {
      scope: "presence",
      type: "welcome",
      selfPlayerId: record.playerId,
      lobbyCode: this.room.id,
    });
    this.send<LobbyStateMsg>(sender, {
      scope: "lobby",
      type: "state",
      state: this.state,
    });
    void isNew;
    this.broadcastPlayerList();
  }

  // ─── GM grace period ─────────────────────────────────────────────────────

  private startGmGrace() {
    this.gmGraceUntil = Date.now() + GM_GRACE_MS;
    if (this.gmGraceTimer) clearTimeout(this.gmGraceTimer);
    this.gmGraceTimer = setTimeout(() => this.resolveGmGrace(), GM_GRACE_MS);
    this.broadcastPlayerList();
  }

  private cancelGmGrace() {
    this.gmGraceUntil = null;
    if (this.gmGraceTimer) {
      clearTimeout(this.gmGraceTimer);
      this.gmGraceTimer = null;
    }
  }

  private resolveGmGrace() {
    this.gmGraceTimer = null;
    this.gmGraceUntil = null;

    // If the original GM is back, nothing to do (cancelGmGrace would have run).
    const currentGm = this.gmPlayerId
      ? this.registry.getByPlayerId(this.gmPlayerId)
      : null;
    if (currentGm?.connectionId) {
      this.broadcastPlayerList();
      return;
    }

    const heir = this.registry.longestConnected(this.gmPlayerId ?? undefined);
    this.gmPlayerId = heir?.playerId ?? null;
    this.broadcastPlayerList();
  }

  // ─── broadcast helpers ───────────────────────────────────────────────────

  private broadcastPlayerList() {
    const msg: PlayerListMsg = {
      scope: "presence",
      type: "player-list",
      players: this.registry.toPublic(this.gmPlayerId),
      gmPlayerId: this.gmPlayerId,
      gmGraceUntil: this.gmGraceUntil,
    };
    this.room.broadcast(JSON.stringify(msg));
  }

  private send<T extends ServerToClient>(conn: Party.Connection, msg: T) {
    conn.send(JSON.stringify(msg));
  }
}
