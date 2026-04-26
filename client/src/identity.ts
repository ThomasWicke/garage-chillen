// Persistent local identity. UUID is generated once and never changes (until
// the user clears storage). Nickname & avatar are also persisted across visits.
//
// Avatars are sourced from the @kaplayjs/crew package, whose asset entries
// expose a `.sprite` data-URI suitable for both <img> tags and Kaplay's
// loadSprite. This keeps the same avatar set in sync between the DOM lobby UI
// and the Kaplay-rendered mini-game scenes.

import { v4 as uuidv4 } from "uuid";
import type { CrewAsset, SpriteCrewItem } from "@kaplayjs/crew";
import {
  bagData,
  beanData,
  boboData,
  ghostyData,
  gigagantrumData,
  gladyData,
  katData,
  markData,
  marrocData,
  sukomiData,
} from "@kaplayjs/crew";

export type Avatar = { id: string; src: string; name: string };

// All entries are statically known to be sprites; narrow the CrewAsset union.
function sprite(d: CrewAsset): SpriteCrewItem & { pack: string } {
  if (d.kind !== "Sprite") {
    throw new Error(`Crew asset ${d.name} is not a sprite`);
  }
  return d as SpriteCrewItem & { pack: string };
}

export const AVATARS: readonly Avatar[] = (
  [
    ["bean", beanData],
    ["ghosty", ghostyData],
    ["mark", markData],
    ["kat", katData],
    ["bag", bagData],
    ["marroc", marrocData],
    ["bobo", boboData],
    ["glady", gladyData],
    ["sukomi", sukomiData],
    ["gigagantrum", gigagantrumData],
  ] as const
).map(([id, data]) => {
  const s = sprite(data);
  // Always use the outlined variant — looks crisper on dark backgrounds.
  return { id, src: s.outlined, name: s.name };
});

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

export function avatarSrc(avatarId: string): string {
  return AVATARS.find((a) => a.id === avatarId)?.src ?? AVATARS[0].src;
}
