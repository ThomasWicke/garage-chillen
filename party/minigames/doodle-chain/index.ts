// Doodle Chain — Telestrations / "Gartic Phone" style telephone with
// drawings, played IN THE ROOM. Last-man-standing (everyone in one match).
//
// n players, chain length L = clamp(n, 3, 6). Chain c starts with player c;
// step s of chain c is done by player (c + s) mod n — so on every step,
// EVERY player is busy with exactly one chain:
//   step 0  prompt  everyone types a word / short phrase (fallback list)
//   step 1  draw    draw the prompt you received
//   step 2  guess   guess what the drawing you received shows
//   step 3  draw    draw that guess … alternating until L steps are done
// Then the ALBUM: chains are replayed one step at a time on every phone
// (prompts auto-advance; a drawing or a guess stays up until everyone but
// its author has tapped ♥ or "no ♥", or 12s/9s). Hearts on your drawings
// AND on your guesses are the score. +2 for a guesser whose guess matches the chain's original
// prompt (kept it alive). Placements: points desc, ties share.
//
// Per-player content (what to draw / guess) goes via `task` messages
// (sendTo, on step start + on `need-task`); drawings arrive stroke by
// stroke so a disconnect loses at most the current stroke.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const PROMPT_MS = 25_000;
const DRAW_MS = 50_000;
const GUESS_MS = 30_000;
/** Album pacing: prompt steps auto-advance; drawing AND guess steps advance
 *  as soon as everyone (except the author) has tapped ♥ or "no ♥", else at
 *  timeout. */
const ALBUM_TEXT_MS = 4_000;
const ALBUM_GUESS_MS = 9_000;
const ALBUM_DRAW_MS = 12_000;
/** Once the last response is in, linger a moment so the count is seen. */
const ALBUM_SETTLE_MS = 1_200;
const RESULTS_MS = 8_000;
const HEARTBEAT_MS = 500;
const MIN_CHAIN = 3;
const MAX_CHAIN = 6;
const MAX_TEXT_LEN = 40;
const MAX_STROKES = 250;
const MAX_STROKE_POINTS = 200;
const COORD_MAX = 1000;
const NUM_COLORS = 9;
const NUM_WIDTHS = 3;
const MATCH_PTS = 2;
const MAX_PLAYERS = 10;

/** Worst case (10 players, L=6): prompt + 3 draws + 2 guesses + album (10×6
 *  steps) + results ≈ 7 min; safety net above that. */
const DC_MATCH_TIMEOUT_MS =
  PROMPT_MS +
  3 * DRAW_MS +
  2 * GUESS_MS +
  MAX_PLAYERS * MAX_CHAIN * ALBUM_DRAW_MS +
  RESULTS_MS +
  20_000;

const FALLBACK_PROMPTS = [
  "a cat riding a skateboard",
  "a dinosaur eating pizza",
  "a snowman on the beach",
  "a shark in a bathtub",
  "a robot walking a dog",
  "a giraffe in a tiny car",
  "a penguin DJ",
  "a pirate cooking pasta",
  "a ghost at the gym",
  "an octopus playing drums",
  "a cow on the moon",
  "a unicorn stuck in traffic",
  "a dragon toasting marshmallows",
  "a hamster lifting weights",
  "a monkey doing taxes",
  "a frog on a motorbike",
  "a llama at a wedding",
  "a wizard on a scooter",
  "a t-rex trying to clap",
  "a spider knitting a scarf",
  "a sloth running a marathon",
  "a fish riding a bicycle",
  "a bear ordering coffee",
  "a snail on a rollercoaster",
  "a crocodile brushing its teeth",
  "a duck in a business meeting",
  "a kangaroo playing basketball",
  "an alien at a barbecue",
  "a zombie walking a cat",
  "a chicken flying a plane",
];

type Phase = "prompt" | "draw" | "guess" | "album" | "results" | "ended";
type StepKind = "prompt" | "draw" | "guess";
type Stroke = { c: number; w: number; p: number[] };
type Step = {
  kind: StepKind;
  playerId: string;
  text: string;
  strokes: Stroke[];
  /** Player tapped submit / done (counts for early finish). */
  done: boolean;
  /** Text was auto-filled (empty prompt → fallback, empty guess → "???"). */
  auto: boolean;
};

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function sanitizeStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { c?: unknown; w?: unknown; p?: unknown };
  const c = typeof r.c === "number" ? Math.floor(r.c) : 0;
  const w = typeof r.w === "number" ? Math.floor(r.w) : 1;
  if (c < 0 || c >= NUM_COLORS || w < 0 || w >= NUM_WIDTHS) return null;
  if (!Array.isArray(r.p) || r.p.length < 2) return null;
  const p: number[] = [];
  const max = Math.min(r.p.length - (r.p.length % 2), MAX_STROKE_POINTS * 2);
  for (let i = 0; i < max; i++) {
    const v = r.p[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    p.push(Math.max(0, Math.min(COORD_MAX, Math.round(v))));
  }
  return { c, w, p };
}

function createDoodleChainMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const n = players.length;
  const participantIds = new Set(players.map((p) => p.playerId));
  const connected = new Set(players.map((p) => p.playerId));
  const L = Math.max(MIN_CHAIN, Math.min(MAX_CHAIN, n));

  const kindOf = (s: number): StepKind =>
    s === 0 ? "prompt" : s % 2 === 1 ? "draw" : "guess";
  const playerAt = (c: number, s: number) => players[(c + s) % n].playerId;

  const chains: Step[][] = [];
  for (let c = 0; c < n; c++) {
    const steps: Step[] = [];
    for (let s = 0; s < L; s++) {
      steps.push({
        kind: kindOf(s),
        playerId: playerAt(c, s),
        text: "",
        strokes: [],
        done: false,
        auto: false,
      });
    }
    chains.push(steps);
  }
  /** Which chain each player works on at the current step. */
  const chainFor = (pid: string, s: number): number => {
    const idx = players.findIndex((p) => p.playerId === pid);
    return (((idx - s) % n) + n) % n;
  };

  const fallbacks = [...FALLBACK_PROMPTS];
  shuffleInPlace(fallbacks);
  let fallbackIdx = 0;

  const likes = new Map<string, Set<string>>(); // "c:s" → liker ids
  /** Players who have responded (♥ or pass) to the current album drawing. */
  const albumResponded = new Set<string>();
  const points: Record<string, number> = {};
  for (const p of players) points[p.playerId] = 0;

  let tasksSent = false;
  const state = {
    phase: "prompt" as Phase,
    stepIndex: 0,
    phaseEndsAt: ctx.startAt + PROMPT_MS,
    albumChain: 0,
    albumStep: 0,
    ended: false,
    dirty: true,
    lastSentAt: 0,
  };

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  ctx.broadcast({
    type: "welcome",
    deadlineAt: ctx.deadlineAt,
    startAt: ctx.startAt,
    chainLength: L,
    phaseDurations: {
      prompt: PROMPT_MS,
      draw: DRAW_MS,
      guess: GUESS_MS,
      albumText: ALBUM_TEXT_MS,
      albumDraw: ALBUM_DRAW_MS,
      results: RESULTS_MS,
    },
    scoring: { match: MATCH_PTS },
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  // ─── tasks (per-player content) ─────────────────────────────────────────

  function sendTask(pid: string) {
    if (state.phase !== "prompt" && state.phase !== "draw" && state.phase !== "guess") return;
    const s = state.stepIndex;
    const c = chainFor(pid, s);
    const step = chains[c][s];
    const prev = s > 0 ? chains[c][s - 1] : null;
    ctx.sendTo(pid, {
      type: "task",
      stepIndex: s,
      chain: c,
      kind: step.kind,
      input: prev
        ? prev.kind === "draw"
          ? { kind: "draw", strokes: prev.strokes, by: prev.playerId }
          : { kind: "text", text: prev.text, by: prev.playerId }
        : null,
      // Own progress, for reconnects.
      mine: {
        text: step.text,
        strokes: step.kind === "draw" ? step.strokes : [],
        done: step.done,
      },
    });
  }

  function sendAllTasks() {
    for (const pid of connected) sendTask(pid);
  }

  // ─── phase machine ──────────────────────────────────────────────────────

  function finalizeStep(s: number) {
    for (let c = 0; c < n; c++) {
      const step = chains[c][s];
      if (step.kind === "prompt" && normalizeText(step.text).length === 0) {
        step.text = fallbacks[fallbackIdx++ % fallbacks.length];
        step.auto = true;
      } else if (step.kind === "guess" && normalizeText(step.text).length === 0) {
        step.text = "???";
        step.auto = true;
      }
    }
  }

  function startStep(s: number, now: number) {
    state.stepIndex = s;
    const kind = kindOf(s);
    state.phase = kind;
    state.phaseEndsAt =
      now + (kind === "prompt" ? PROMPT_MS : kind === "draw" ? DRAW_MS : GUESS_MS);
    state.dirty = true;
    sendAllTasks();
  }

  function albumStepMs(c: number, s: number): number {
    const k = chains[c][s].kind;
    return k === "draw" ? ALBUM_DRAW_MS : k === "guess" ? ALBUM_GUESS_MS : ALBUM_TEXT_MS;
  }
  /** Drawings and guesses take ♥ / no ♥; prompts don't. */
  const heartable = (kind: StepKind) => kind === "draw" || kind === "guess";

  function broadcastAlbum() {
    const c = state.albumChain;
    const s = state.albumStep;
    ctx.broadcast({
      type: "album",
      chain: c,
      step: s,
      chainLength: L,
      totalChains: n,
      startedBy: chains[c][0].playerId,
      // Everything revealed so far in this chain.
      entries: chains[c].slice(0, s + 1).map((st) => ({
        kind: st.kind,
        playerId: st.playerId,
        text: st.kind === "draw" ? "" : st.text,
        strokes: st.kind === "draw" ? st.strokes : [],
        auto: st.auto,
      })),
    });
  }

  function startAlbum(now: number) {
    state.phase = "album";
    state.albumChain = 0;
    state.albumStep = 0;
    state.phaseEndsAt = now + albumStepMs(0, 0);
    state.dirty = true;
    awardMatches();
    broadcastAlbum();
  }

  /** Advance the album one step; returns false when the album is over. */
  function albumNext(now: number): boolean {
    let c = state.albumChain;
    let s = state.albumStep + 1;
    if (s >= L) {
      c++;
      s = 0;
    }
    if (c >= n) return false;
    state.albumChain = c;
    state.albumStep = s;
    state.phaseEndsAt = now + albumStepMs(c, s);
    albumResponded.clear();
    state.dirty = true;
    broadcastAlbum();
    return true;
  }

  /** Drawing / guess step: everyone but the author responded → settle, then
   *  advance. */
  function maybeSettleAlbum(now: number) {
    const step = chains[state.albumChain][state.albumStep];
    if (!heartable(step.kind)) return;
    for (const pid of connected) {
      if (pid === step.playerId) continue;
      if (!albumResponded.has(pid)) return;
    }
    state.phaseEndsAt = Math.min(state.phaseEndsAt, now + ALBUM_SETTLE_MS);
    state.dirty = true;
  }

  function awardMatches() {
    for (let c = 0; c < n; c++) {
      const original = normalizeText(chains[c][0].text);
      if (!original) continue;
      for (let s = 2; s < L; s += 2) {
        const st = chains[c][s];
        if (!st.auto && normalizeText(st.text) === original) {
          points[st.playerId] = (points[st.playerId] ?? 0) + MATCH_PTS;
        }
      }
    }
  }

  function enterResults(now: number) {
    state.phase = "results";
    state.phaseEndsAt = now + RESULTS_MS;
    state.dirty = true;
  }

  function likesOut(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, set] of likes) out[k] = set.size;
    return out;
  }

  function doneIds(): string[] {
    const s = state.stepIndex;
    return players
      .filter((p) => chains[chainFor(p.playerId, s)][s].done)
      .map((p) => p.playerId);
  }

  function broadcastState(force = false) {
    const now = Date.now();
    if (!force && !state.dirty && now - state.lastSentAt < HEARTBEAT_MS) return;
    state.dirty = false;
    state.lastSentAt = now;
    const working =
      state.phase === "prompt" || state.phase === "draw" || state.phase === "guess";
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      stepIndex: state.stepIndex,
      chainLength: L,
      phaseEndsAt: state.phaseEndsAt,
      deadlineAt: ctx.deadlineAt,
      doneIds: working ? doneIds() : [],
      connected: [...connected],
      album:
        state.phase === "album"
          ? { chain: state.albumChain, step: state.albumStep, total: n }
          : null,
      likes: likesOut(),
      albumResponded: state.phase === "album" ? [...albumResponded] : [],
      points,
    });
  }

  function computePlacements(): { placements: Record<string, number>; topIds: string[] } {
    const ids = players.map((p) => p.playerId);
    ids.sort((a, b) => (points[b] ?? 0) - (points[a] ?? 0));
    const out: Record<string, number> = {};
    let i = 0;
    let rank = 1;
    while (i < ids.length) {
      let j = i;
      while (j < ids.length && (points[ids[j]] ?? 0) === (points[ids[i]] ?? 0)) j++;
      for (let g = i; g < j; g++) out[ids[g]] = rank;
      rank += j - i;
      i = j;
    }
    return { placements: out, topIds: ids.filter((id) => out[id] === 1) };
  }

  function endWith(prefix: string) {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const { placements, topIds } = computePlacements();
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const summary = winnerId
      ? `${prefix}${nickOf(winnerId)} wins with ${points[winnerId] ?? 0} ♥`
      : `${prefix}it's a tie`;
    broadcastState(true);
    ctx.endMatch({ winnerId, placements, scores: { ...points }, summary });
  }

  function connectedCount(): number {
    let c = 0;
    for (const pid of connected) if (participantIds.has(pid)) c++;
    return c;
  }

  function allDone(): boolean {
    const s = state.stepIndex;
    for (const pid of connected) {
      if (!chains[chainFor(pid, s)][s].done) return false;
    }
    return true;
  }

  function maybeFinishEarly(now: number) {
    if (allDone()) {
      state.phaseEndsAt = Math.max(now, ctx.startAt);
      state.dirty = true;
    }
  }

  return {
    tick() {
      if (state.ended) return;
      const now = Date.now();
      if (now >= ctx.deadlineAt) {
        endWith("time's up · ");
        return;
      }
      if (now < ctx.startAt) {
        broadcastState();
        // Prompt tasks go out during warm-up so the input is ready at GO.
        if (!tasksSent) {
          tasksSent = true;
          sendAllTasks();
        }
        return;
      }
      if (!tasksSent) {
        tasksSent = true;
        sendAllTasks();
      }
      if (connectedCount() < 2) {
        endWith("not enough players · ");
        return;
      }
      if (now >= state.phaseEndsAt) {
        if (
          state.phase === "prompt" ||
          state.phase === "draw" ||
          state.phase === "guess"
        ) {
          finalizeStep(state.stepIndex);
          if (state.stepIndex + 1 < L) startStep(state.stepIndex + 1, now);
          else startAlbum(now);
        } else if (state.phase === "album") {
          if (!albumNext(now)) enterResults(now);
        } else if (state.phase === "results") {
          endWith("");
          return;
        }
      }
      broadcastState();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      const now = Date.now();
      if (!participantIds.has(playerId) || !connected.has(playerId)) return;

      if (msg.type === "need-task") {
        sendTask(playerId);
        return;
      }
      // No warm-up gate: typing / doodling during the 3-2-1 is harmless.
      if (msg.type === "need-album") {
        if (state.phase === "album") broadcastAlbum();
        return;
      }

      const working =
        state.phase === "prompt" || state.phase === "draw" || state.phase === "guess";
      if (working) {
        const s = state.stepIndex;
        const step = chains[chainFor(playerId, s)][s];
        if (step.done) return; // submitted = locked

        if (step.kind === "draw") {
          if (msg.type === "stroke") {
            const st = sanitizeStroke(msg.stroke);
            if (!st) return;
            if (step.strokes.length >= MAX_STROKES) return;
            step.strokes.push(st);
          } else if (msg.type === "undo") {
            step.strokes.pop();
          } else if (msg.type === "clear") {
            step.strokes = [];
          } else if (msg.type === "done") {
            step.done = true;
            state.dirty = true;
            maybeFinishEarly(now);
          }
          return;
        }
        // prompt / guess: text
        if (msg.type !== "text") return;
        if (typeof msg.text !== "string") return;
        step.text = msg.text.trim().slice(0, MAX_TEXT_LEN);
        if (msg.final === true && normalizeText(step.text).length > 0) {
          step.done = true;
          state.dirty = true;
          maybeFinishEarly(now);
        }
        return;
      }

      if (state.phase === "album") {
        if (msg.type !== "like" && msg.type !== "pass") return;
        const c = msg.chain;
        const s = msg.step;
        if (typeof c !== "number" || typeof s !== "number") return;
        // Only the drawing currently on screen.
        if (c !== state.albumChain || s !== state.albumStep) return;
        const step = chains[c][s];
        if (!heartable(step.kind)) return;
        if (step.playerId === playerId) return; // no voting on your own work
        if (albumResponded.has(playerId)) return; // one response, final
        albumResponded.add(playerId);
        if (msg.type === "like") {
          const key = `${c}:${s}`;
          let set = likes.get(key);
          if (!set) {
            set = new Set();
            likes.set(key, set);
          }
          set.add(playerId);
          points[step.playerId] = (points[step.playerId] ?? 0) + 1;
        }
        state.dirty = true;
        maybeSettleAlbum(now);
      }
    },

    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!connected.has(playerId)) return;
      connected.delete(playerId);
      state.dirty = true;
      const now = Date.now();
      if (now < ctx.startAt) return;
      const working =
        state.phase === "prompt" || state.phase === "draw" || state.phase === "guess";
      if (working) maybeFinishEarly(now);
      if (state.phase === "album") maybeSettleAlbum(now);
    },

    cleanup() {},
  };
}

const DoodleChainDefinition: MiniGameDefinition = {
  id: "doodle-chain",
  displayName: "Doodle Chain",
  gamemode: "last-man-standing",
  matchSize: MAX_PLAYERS,
  minPlayers: 3,
  maxPlayers: MAX_PLAYERS,
  orientation: "portrait",
  tickHz: 10,
  matchTimeoutMs: DC_MATCH_TIMEOUT_MS,
  shuffleWeight: 1,
  createMatch: createDoodleChainMatch,
};

registerMiniGame(DoodleChainDefinition);

export default DoodleChainDefinition;
