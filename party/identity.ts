// Player registry — keys players by their `playerId` (UUID from localStorage),
// not by transient connection ids. A refresh, lost-wifi-for-8-seconds, or
// closed-and-reopened-the-app all reconnect to the same player slot.

import { AVATAR_ORDER } from "./avatars";
import type { PublicPlayer } from "./protocol";

export type PlayerRecord = {
  playerId: string;
  nickname: string;
  avatarId: string;
  connectionId: string | null; // null when disconnected; set when connected
  joinedAt: number; // epoch ms; used for GM auto-promotion (longest-connected wins)
};

const NICKNAME_MAX = 16;

export type NicknameRejectReason = "duplicate" | "invalid";

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
      // existing player reconnecting (or sending identify multiple times).
      // Per the rule "rotation runs again on reconnect": we re-validate the
      // nickname and avatar via the same join logic. Their own existing slot
      // counts as held, so in normal cases nothing changes.
      if (existing.connectionId && existing.connectionId !== args.connectionId) {
        this.connToPlayer.delete(existing.connectionId);
      }
      existing.connectionId = args.connectionId;
      existing.nickname = this.uniqueNickname(args.nickname, args.playerId);
      existing.avatarId = this.uniqueAvatar(args.avatarId, args.playerId);
      this.connToPlayer.set(args.connectionId, args.playerId);
      return { record: existing, isNew: false };
    }
    const record: PlayerRecord = {
      playerId: args.playerId,
      nickname: this.uniqueNickname(args.nickname, args.playerId),
      avatarId: this.uniqueAvatar(args.avatarId, args.playerId),
      connectionId: args.connectionId,
      joinedAt: Date.now(),
    };
    this.players.set(args.playerId, record);
    this.connToPlayer.set(args.connectionId, args.playerId);
    return { record, isNew: true };
  }

  /**
   * Strict in-lobby nickname change. Unlike `upsert`, this does NOT auto-amend
   * with `(2)` on collision — it returns a rejection so the caller can surface
   * it to the editing user.
   */
  setNicknameStrict(
    playerId: string,
    requested: string,
  ): { ok: true; record: PlayerRecord } | { ok: false; reason: NicknameRejectReason } {
    const r = this.players.get(playerId);
    if (!r) return { ok: false, reason: "invalid" };
    const trimmed = requested.trim().slice(0, NICKNAME_MAX);
    if (!trimmed) return { ok: false, reason: "invalid" };
    if (trimmed === r.nickname) return { ok: true, record: r }; // no-op
    const taken = new Set(
      this.all()
        .filter((p) => p.playerId !== playerId)
        .map((p) => p.nickname),
    );
    if (taken.has(trimmed)) return { ok: false, reason: "duplicate" };
    r.nickname = trimmed;
    return { ok: true, record: r };
  }

  /** In-lobby avatar change. Rotates if the requested avatar is taken
   *  (unless the registry is at or above avatar capacity, in which case
   *  duplicates are allowed). */
  setAvatarRotated(playerId: string, requested: string): PlayerRecord | null {
    const r = this.players.get(playerId);
    if (!r) return null;
    r.avatarId = this.uniqueAvatar(requested, playerId);
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

  /** Append (2), (3), … to nicknames that collide on join. Used by `upsert`
   *  only — in-lobby edits use `setNicknameStrict` which rejects instead. */
  private uniqueNickname(requested: string, ownPlayerId: string): string {
    const trimmed = requested.trim().slice(0, NICKNAME_MAX) || "anon";
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

  /**
   * Resolve an avatarId given the current registry state. If the requested
   * avatar is held by some other record, rotate forward through the fixed
   * avatar order until we find a free one. If every avatar is held — i.e.
   * total records ≥ avatar count — duplicates are allowed; return as-is.
   *
   * The current player's own slot does not count as taken (so reconnects /
   * idempotent identify calls don't kick the player off their own avatar).
   */
  private uniqueAvatar(requested: string, ownPlayerId: string): string {
    const others = this.all().filter((p) => p.playerId !== ownPlayerId);
    // Once total records (including the current one if new) reaches the
    // avatar capacity, we run out of unique slots. Allow duplicates.
    const totalIfAdded = others.length + 1;
    if (totalIfAdded > AVATAR_ORDER.length) return requested;
    const taken = new Set(others.map((p) => p.avatarId));
    if (!taken.has(requested)) return requested;
    const startIdx = AVATAR_ORDER.indexOf(requested);
    const start = startIdx >= 0 ? startIdx : 0;
    for (let i = 1; i <= AVATAR_ORDER.length; i++) {
      const candidate = AVATAR_ORDER[(start + i) % AVATAR_ORDER.length];
      if (!taken.has(candidate)) return candidate;
    }
    return requested;
  }
}
