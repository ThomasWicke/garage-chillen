import type { GamemodeClientDefinition } from "./types";

const REGISTRY = new Map<string, GamemodeClientDefinition>();

export function registerGamemodeClient(def: GamemodeClientDefinition): void {
  if (REGISTRY.has(def.id)) {
    throw new Error(`Gamemode client ${def.id} already registered`);
  }
  REGISTRY.set(def.id, def);
}

export function getGamemodeClient(
  id: string,
): GamemodeClientDefinition | null {
  return REGISTRY.get(id) ?? null;
}
