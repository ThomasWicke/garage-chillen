// Server's mirror of the client AVATARS list. Keep IDs in sync with
// `client/src/identity.ts`. Order matters — it's the cycle order used for
// rotation when a chosen avatar is already taken.

export const AVATAR_ORDER: readonly string[] = [
  "bean",
  "ghosty",
  "mark",
  "kat",
  "bag",
  "marroc",
  "bobo",
  "glady",
  "sukomi",
  "gigagantrum",
];

export const AVATAR_COUNT = AVATAR_ORDER.length;
