import type { MiniGameClientDefinition } from "./types";

const REGISTRY = new Map<string, MiniGameClientDefinition>();

export function registerMiniGameClient(def: MiniGameClientDefinition): void {
  if (REGISTRY.has(def.id)) {
    throw new Error(`MiniGame client ${def.id} already registered`);
  }
  REGISTRY.set(def.id, def);
}

export function getMiniGameClient(id: string): MiniGameClientDefinition | null {
  return REGISTRY.get(id) ?? null;
}
