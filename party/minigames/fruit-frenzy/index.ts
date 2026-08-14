// Fruit Frenzy — last-man-standing FFA score race. The server launches
// fruits (and the occasional bomb) from the bottom of a shared 500×800
// portrait field; they rise, arc, and fall under a simple ballistic sim
// integrated in tick (30 Hz). Everyone sees the SAME entities — the first
// player to tap a fruit claims it (+1). Tapping a bomb costs 3 points
// (floored at 0) and stuns the tapper for 1.5s (their taps are ignored).
// Highest score when the 45s clock runs out wins; score ties share a rank.
//
// Wire protocol (documented for the client):
//   welcome: { field, durationMs, endsAt, deadlineAt, stunMs, players }
//   state:   { entities: [{id, kind: "fruit"|"bomb", sprite, x, y}],
//              scores: Record<pid, int>, stuns: Record<pid, stunnedUntil>,
//              events: [{ev: "sliced"|"boom", id, by, x, y, sprite}],
//              endsAt, deadlineAt }
//   `events` carries the slice/boom happenings since the previous state
//   broadcast (cleared after each send) so clients can play pop animations.
// Client → server: { type: "slice", id: number }

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const FF_FIELD_W = 500;
export const FF_FIELD_H = 800;

const DURATION_MS = 45_000;
const FF_MATCH_TIMEOUT_MS = 60_000;

const GRAVITY = 600; // px/s², downward (+y is down)
const SPAWN_MIN_MS = 500;
const SPAWN_MAX_MS = 900;
const SPAWN_MIN_COUNT = 1;
const SPAWN_MAX_COUNT = 3;
const BOMB_CHANCE = 0.15;
const BOMB_PENALTY = 3;
const STUN_MS = 1_500;

// Crew sprite keys — the client maps these to @kaplayjs/crew data URIs.
const FRUIT_SPRITES = ["watermelon", "apple", "pineapple", "grape", "mushroom"];
const BOMB_SPRITE = "skuller"; // crew skull — reads "do not tap"

type Entity = {
  id: number;
  kind: "fruit" | "bomb";
  sprite: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type SliceEvent = {
  ev: "sliced" | "boom";
  id: number;
  by: string;
  x: number;
  y: number;
  sprite: string;
};

type GameState = {
  entities: Entity[];
  entityIdCounter: number;
  scores: Map<string, number>;
  stunnedUntil: Map<string, number>;
  pendingEvents: SliceEvent[];
  endsAt: number;
  nextSpawnAt: number;
  ended: boolean;
};

function randRange(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function createFruitFrenzyMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const state: GameState = {
    entities: [],
    entityIdCounter: 0,
    scores: new Map(players.map((p) => [p.playerId, 0])),
    stunnedUntil: new Map(players.map((p) => [p.playerId, 0])),
    pendingEvents: [],
    // 45s play window counts from GO, not creation.
    endsAt: ctx.startAt + DURATION_MS,
    // First spawn anchored to GO — nothing launches during warm-up.
    nextSpawnAt: ctx.startAt + Math.round(randRange(SPAWN_MIN_MS, SPAWN_MAX_MS)),
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    field: { w: FF_FIELD_W, h: FF_FIELD_H },
    durationMs: DURATION_MS,
    endsAt: state.endsAt,
    deadlineAt: ctx.deadlineAt,
    stunMs: STUN_MS,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function broadcastState() {
    const scoresObj: Record<string, number> = {};
    for (const [pid, s] of state.scores) scoresObj[pid] = s;
    const stunsObj: Record<string, number> = {};
    for (const [pid, until] of state.stunnedUntil) stunsObj[pid] = until;
    ctx.broadcast({
      type: "state",
      entities: state.entities.map((e) => ({
        id: e.id,
        kind: e.kind,
        sprite: e.sprite,
        x: Math.round(e.x),
        y: Math.round(e.y),
      })),
      scores: scoresObj,
      stuns: stunsObj,
      events: state.pendingEvents.splice(0, state.pendingEvents.length),
      endsAt: state.endsAt,
      deadlineAt: ctx.deadlineAt,
    });
  }

  function spawnBurst() {
    const count = Math.floor(randRange(SPAWN_MIN_COUNT, SPAWN_MAX_COUNT + 1));
    for (let i = 0; i < count; i++) {
      const isBomb = Math.random() < BOMB_CHANCE;
      const x = randRange(60, FF_FIELD_W - 60);
      state.entities.push({
        id: state.entityIdCounter++,
        kind: isBomb ? "bomb" : "fruit",
        sprite: isBomb
          ? BOMB_SPRITE
          : FRUIT_SPRITES[Math.floor(Math.random() * FRUIT_SPRITES.length)],
        x,
        y: FF_FIELD_H + 40,
        // Gentle drift toward the middle so arcs stay on-screen.
        vx: (FF_FIELD_W / 2 - x) * 0.12 + randRange(-40, 40),
        // Launch speed → peak between ~1/6 and ~2/3 field height.
        vy: -randRange(650, 950),
      });
    }
  }

  function step(dt: number) {
    const now = Date.now();
    // Spawn bursts on a randomized interval.
    if (now >= state.nextSpawnAt) {
      spawnBurst();
      state.nextSpawnAt = now + Math.round(randRange(SPAWN_MIN_MS, SPAWN_MAX_MS));
    }
    // Ballistic integration; clamp dt so a hiccup doesn't teleport fruit.
    const d = Math.min(dt, 0.1);
    for (const e of state.entities) {
      e.vy += GRAVITY * d;
      e.x += e.vx * d;
      e.y += e.vy * d;
    }
    // Despawn entities that fell back out of the bottom.
    state.entities = state.entities.filter(
      (e) => !(e.vy > 0 && e.y > FF_FIELD_H + 80),
    );
  }

  function computePlacements(): Record<string, number> {
    // Score desc; equal scores SHARE a rank (grouped-rank loop).
    type Entry = { playerId: string; score: number };
    const entries: Entry[] = [];
    for (const [pid, s] of state.scores) entries.push({ playerId: pid, score: s });
    entries.sort((a, b) => b.score - a.score);
    const out: Record<string, number> = {};
    let rank = 1;
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (j < entries.length && entries[j].score === entries[i].score) j++;
      for (let g = i; g < j; g++) out[entries[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    return out;
  }

  function endNow(reasonPrefix: string) {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const scoresObj: Record<string, number> = {};
    for (const [pid, s] of state.scores) scoresObj[pid] = s;
    const summary = winnerId
      ? `${reasonPrefix}${players.find((p) => p.playerId === winnerId)?.nickname ?? "?"} wins · ${state.scores.get(winnerId) ?? 0} fruits`
      : `${reasonPrefix}tie at ${state.scores.get(topIds[0]) ?? 0} fruits`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, scores: scoresObj, summary });
  }

  return {
    tick(dt: number) {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endNow("time's up · ");
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: clients render the (empty) frozen scene; nothing advances.
        broadcastState();
        return;
      }
      if (Date.now() >= state.endsAt) {
        endNow("");
        return;
      }
      step(dt);
      if (state.ended) return;
      broadcastState();
    },
    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (msg.type !== "slice") return;
      if (!state.scores.has(playerId)) return; // not a participant
      const id =
        typeof msg.id === "number" && Number.isFinite(msg.id) ? msg.id : null;
      if (id === null) return;
      const now = Date.now();
      if ((state.stunnedUntil.get(playerId) ?? 0) > now) return; // stunned
      const idx = state.entities.findIndex((e) => e.id === id);
      if (idx < 0) return; // already claimed / despawned
      const ent = state.entities[idx];
      // First tap wins the race — remove the entity either way.
      state.entities.splice(idx, 1);
      if (ent.kind === "fruit") {
        state.scores.set(playerId, (state.scores.get(playerId) ?? 0) + 1);
        state.pendingEvents.push({
          ev: "sliced",
          id: ent.id,
          by: playerId,
          x: Math.round(ent.x),
          y: Math.round(ent.y),
          sprite: ent.sprite,
        });
      } else {
        state.scores.set(
          playerId,
          Math.max(0, (state.scores.get(playerId) ?? 0) - BOMB_PENALTY),
        );
        state.stunnedUntil.set(playerId, now + STUN_MS);
        state.pendingEvents.push({
          ev: "boom",
          id: ent.id,
          by: playerId,
          x: Math.round(ent.x),
          y: Math.round(ent.y),
          sprite: ent.sprite,
        });
      }
    },
    onPlayerLeft() {
      // Score race: a leaver's score stands, they just stop slicing
      // (same policy as whack-a-mole — there is no survival state to forfeit).
    },
    cleanup() {},
  };
}

const FruitFrenzyDefinition: MiniGameDefinition = {
  id: "fruit-frenzy",
  displayName: "Fruit Frenzy",
  gamemode: "last-man-standing",
  // FFA — the match takes the full lobby; matchSize is metadata here.
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: FF_MATCH_TIMEOUT_MS,
  shuffleWeight: 3,
  createMatch: createFruitFrenzyMatch,
};

registerMiniGame(FruitFrenzyDefinition);

export default FruitFrenzyDefinition;
