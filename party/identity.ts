// Player registry — keys players by their `playerId` (UUID from localStorage),
// not by transient connection ids. A refresh, lost-wifi-for-8-seconds, or
// closed-and-reopened-the-app all reconnect to the same player slot.

import type { PublicPlayer } from "./protocol";

export type PlayerRecord = {
  playerId: string;
  nickname: string;
  avatarId: string;
  connectionId: string | null; // null when disconnected; set when connected
  joinedAt: number; // epoch ms; used for GM auto-promotion (longest-connected wins)
};

export class PlayerRegistry {
  private players = new Map<string, PlayerRecord>(); // by playerId
  private connToPlayer = new Map<string, string>(); // connectionId → playerId

  upsert(args: {
    playerId: string;
    nickname: string;
    avatarId: string;
    connectionId: string;
  }): { record: PlayerRecord; isNew: boolean } {
    const existing = this.players.get(args.playerId);
    if (existing) {
      // existing player reconnecting (or sending identify multiple times)
      if (existing.connectionId && existing.connectionId !== args.connectionId) {
        this.connToPlayer.delete(existing.connectionId);
      }
      existing.connectionId = args.connectionId;
      existing.nickname = this.uniqueNickname(args.nickname, args.playerId);
      existing.avatarId = args.avatarId;
      this.connToPlayer.set(args.connectionId, args.playerId);
      return { record: existing, isNew: false };
    }
    const record: PlayerRecord = {
      playerId: args.playerId,
      nickname: this.uniqueNickname(args.nickname, args.playerId),
      avatarId: args.avatarId,
      connectionId: args.connectionId,
      joinedAt: Date.now(),
    };
    this.players.set(args.playerId, record);
    this.connToPlayer.set(args.connectionId, args.playerId);
    return { record, isNew: true };
  }

  setNickname(playerId: string, nickname: string): PlayerRecord | null {
    const r = this.players.get(playerId);
    if (!r) return null;
    r.nickname = this.uniqueNickname(nickname, playerId);
    return r;
  }

  setAvatar(playerId: string, avatarId: string): PlayerRecord | null {
    const r = this.players.get(playerId);
    if (!r) return null;
    r.avatarId = avatarId;
    return r;
  }

  disconnect(connectionId: string): PlayerRecord | null {
    const playerId = this.connToPlayer.get(connectionId);
    if (!playerId) return null;
    this.connToPlayer.delete(connectionId);
    const r = this.players.get(playerId);
    if (!r) return null;
    if (r.connectionId === connectionId) r.connectionId = null;
    return r;
  }

  getByConnection(connectionId: string): PlayerRecord | null {
    const id = this.connToPlayer.get(connectionId);
    return id ? this.players.get(id) ?? null : null;
  }

  getByPlayerId(playerId: string): PlayerRecord | null {
    return this.players.get(playerId) ?? null;
  }

  remove(playerId: string): void {
    const r = this.players.get(playerId);
    if (r?.connectionId) this.connToPlayer.delete(r.connectionId);
    this.players.delete(playerId);
  }

  all(): PlayerRecord[] {
    return [...this.players.values()];
  }

  connected(): PlayerRecord[] {
    return this.all().filter((p) => p.connectionId !== null);
  }

  /** Longest-connected player who is currently connected. Used for GM auto-promotion. */
  longestConnected(excludePlayerId?: string): PlayerRecord | null {
    const candidates = this.connected().filter((p) => p.playerId !== excludePlayerId);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.joinedAt - b.joinedAt);
    return candidates[0];
  }

  toPublic(gmPlayerId: string | null): PublicPlayer[] {
    return this.all().map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
      connected: p.connectionId !== null,
      isGm: p.playerId === gmPlayerId,
    }));
  }

  /** Append (2), (3), … to nicknames that collide with another active player. */
  private uniqueNickname(requested: string, ownPlayerId: string): string {
    const trimmed = requested.trim().slice(0, 16) || "anon";
    const taken = new Set(
      this.all()
        .filter((p) => p.playerId !== ownPlayerId)
        .map((p) => p.nickname),
    );
    if (!taken.has(trimmed)) return trimmed;
    for (let i = 2; i < 100; i++) {
      const candidate = `${trimmed} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${trimmed} (${ownPlayerId.slice(0, 4)})`;
  }
}
