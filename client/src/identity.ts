// Persistent local identity. UUID is generated once and never changes (until
// the user clears storage). Nickname & avatar are also persisted across visits.

import { v4 as uuidv4 } from "uuid";

export type Avatar = { id: string; emoji: string };

// MVP: simple emoji-based avatars for the DOM lobby UI. Mini-game scenes will
// later map these `id`s to Kaplay sprites.
export const AVATARS: readonly Avatar[] = [
  { id: "bean", emoji: "🫘" },
  { id: "ghosty", emoji: "👻" },
  { id: "dino", emoji: "🦖" },
  { id: "dog", emoji: "🐶" },
  { id: "cat", emoji: "🐱" },
  { id: "robot", emoji: "🤖" },
  { id: "alien", emoji: "👽" },
  { id: "frog", emoji: "🐸" },
];

export type Identity = {
  playerId: string;
  nickname: string;
  avatarId: string;
};

const KEY = "gc.identity";

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Identity>;
    if (!parsed.playerId) return null;
    return {
      playerId: parsed.playerId,
      nickname: parsed.nickname ?? "",
      avatarId: parsed.avatarId ?? AVATARS[0].id,
    };
  } catch {
    return null;
  }
}

export function saveIdentity(id: Identity): void {
  localStorage.setItem(KEY, JSON.stringify(id));
}

export function ensureIdentity(): Identity {
  const existing = loadIdentity();
  if (existing) return existing;
  const fresh: Identity = {
    playerId: uuidv4(),
    nickname: "",
    avatarId: AVATARS[Math.floor(Math.random() * AVATARS.length)].id,
  };
  saveIdentity(fresh);
  return fresh;
}

export function avatarEmoji(avatarId: string): string {
  return AVATARS.find((a) => a.id === avatarId)?.emoji ?? "❔";
}
