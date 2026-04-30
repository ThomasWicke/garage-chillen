import type { GamemodeDefinition } from "./types";

const REGISTRY = new Map<string, GamemodeDefinition>();

export function registerGamemode(def: GamemodeDefinition): void {
  if (REGISTRY.has(def.id)) {
    throw new Error(`Gamemode ${def.id} already registered`);
  }
  REGISTRY.set(def.id, def);
}

export function getGamemode(id: string): GamemodeDefinition | null {
  return REGISTRY.get(id) ?? null;
}

export function allGamemodes(): GamemodeDefinition[] {
  return [...REGISTRY.values()];
}
