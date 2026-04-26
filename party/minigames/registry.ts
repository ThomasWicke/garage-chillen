import type { MiniGameDefinition } from "./types";

const REGISTRY = new Map<string, MiniGameDefinition>();

export function registerMiniGame(def: MiniGameDefinition): void {
  if (REGISTRY.has(def.id)) {
    throw new Error(`MiniGame ${def.id} already registered`);
  }
  REGISTRY.set(def.id, def);
}

export function getMiniGame(id: string): MiniGameDefinition | null {
  return REGISTRY.get(id) ?? null;
}

export function allMiniGames(): MiniGameDefinition[] {
  return [...REGISTRY.values()];
}
