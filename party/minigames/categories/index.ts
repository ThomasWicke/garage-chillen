// Categories — Stadt-Land-Fluss / "Name, Place, Animal, Thing" played IN THE
// ROOM. Last-man-standing (everyone in one match).
//
// One letter + 4 categories drawn fresh from a ~24-category pool. Phases:
//   write   (≤75s)  everyone types 4 answers on their phone. The FIRST player
//                   to fill all four and tap STOP gives everyone else 10s —
//                   the classic pressure rule. All done → straight on.
//   review  (≤2min) the whole grid is on every phone. The room argues out
//                   loud; ANYONE can tap an answer to strike it (tap again to
//                   restore) — no anonymous voting, the group decides
//                   verbally and someone applies it. Points update live.
//                   The host can end the review early.
//   results (8s)    final points + placements.
//
// Scoring per category: unique valid answer 10 · duplicate 5 · empty, wrong
// letter or struck 0. Wrong-letter answers are auto-struck (server check on
// the normalized first character). Placements: points desc, ties share.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const WRITE_MS = 75_000;
const STOP_GRACE_MS = 10_000;
const REVIEW_MS = 120_000;
const RESULTS_MS = 8_000;
/** write + review + results = 203s; safety net a bit above. */
const CAT_MATCH_TIMEOUT_MS = WRITE_MS + REVIEW_MS + RESULTS_MS + 12_000;
const HEARTBEAT_MS = 500;
const MAX_ANSWER_LEN = 24;
const NUM_CATEGORIES = 4;
const UNIQUE_PTS = 10;
const DUP_PTS = 5;

/** No Q / X / Y — too few answers in most categories. */
const LETTERS = "ABCDEFGHIJKLMNOPRSTUVWZ";

const CATEGORY_POOL = [
  "City",
  "Country",
  "River or lake",
  "Animal",
  "Food or dish",
  "Fruit or vegetable",
  "Drink",
  "Brand",
  "Band or musician",
  "Movie or series",
  "Video game",
  "Famous person",
  "Fictional character",
  "Body part",
  "Piece of clothing",
  "Sport",
  "Job",
  "Something in a garage",
  "Something in a fridge",
  "Reason to be late",
  "Something you can't buy",
  "Car brand",
  "First name",
  "Something at the beach",
  "Thing that's sticky",
  "Superhero or villain",
];

type Phase = "write" | "review" | "results" | "ended";
type CellStatus = "ok" | "dup" | "empty" | "invalid" | "struck";
type Cell = { text: string; status: CellStatus; pts: number };

/** Lowercase, strip diacritics, collapse non-alphanumerics. Used for the
 *  wrong-letter check and duplicate detection. */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function createCategoriesMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const participantIds = new Set(players.map((p) => p.playerId));
  const connected = new Set(players.map((p) => p.playerId));

  const pool = [...CATEGORY_POOL];
  shuffleInPlace(pool);
  const categories = pool.slice(0, NUM_CATEGORIES);
  const letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  const letterNorm = letter.toLowerCase();

  const answers = new Map<string, string[]>();
  for (const p of players) answers.set(p.playerId, ["", "", "", ""]);
  const doneIds = new Set<string>();
  /** playerId:ci keys of answers struck by the room during review. */
  const struck = new Set<string>();

  const state = {
    phase: "write" as Phase,
    phaseEndsAt: ctx.startAt + WRITE_MS,
    stopperId: null as string | null,
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
    letter,
    categories,
    phaseDurations: {
      write: WRITE_MS,
      stopGrace: STOP_GRACE_MS,
      review: REVIEW_MS,
      results: RESULTS_MS,
    },
    scoring: { unique: UNIQUE_PTS, dup: DUP_PTS },
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  /** Score the grid: per category, valid non-struck answers grouped by
   *  normalized text; alone → UNIQUE, shared → DUP. */
  function scoreGrid(): {
    grid: Record<string, Cell[]>;
    points: Record<string, number>;
  } {
    const grid: Record<string, Cell[]> = {};
    const points: Record<string, number> = {};
    for (const p of players) {
      points[p.playerId] = 0;
      grid[p.playerId] = [];
    }
    for (let ci = 0; ci < NUM_CATEGORIES; ci++) {
      const counts = new Map<string, number>();
      const cells: { pid: string; cell: Cell; norm: string }[] = [];
      for (const p of players) {
        const text = answers.get(p.playerId)?.[ci] ?? "";
        const norm = normalizeAnswer(text);
        let status: CellStatus = "ok";
        if (norm.length === 0) status = "empty";
        else if (!norm.startsWith(letterNorm)) status = "invalid";
        else if (struck.has(`${p.playerId}:${ci}`)) status = "struck";
        if (status === "ok") counts.set(norm, (counts.get(norm) ?? 0) + 1);
        cells.push({ pid: p.playerId, cell: { text, status, pts: 0 }, norm });
      }
      for (const c of cells) {
        if (c.cell.status === "ok") {
          const n = counts.get(c.norm) ?? 1;
          if (n > 1) c.cell.status = "dup";
          c.cell.pts = n > 1 ? DUP_PTS : UNIQUE_PTS;
          points[c.pid] = (points[c.pid] ?? 0) + c.cell.pts;
        }
        grid[c.pid].push(c.cell);
      }
    }
    return { grid, points };
  }

  function broadcastState(force = false) {
    const now = Date.now();
    if (!force && !state.dirty && now - state.lastSentAt < HEARTBEAT_MS) return;
    state.dirty = false;
    state.lastSentAt = now;
    const showGrid = state.phase !== "write";
    const scored = showGrid ? scoreGrid() : null;
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      phaseEndsAt: state.phaseEndsAt,
      deadlineAt: ctx.deadlineAt,
      letter,
      categories,
      doneIds: [...doneIds],
      stopperId: state.stopperId,
      connected: [...connected],
      // Answers stay private until the write phase is over.
      grid: scored?.grid ?? null,
      points: scored?.points ?? null,
    });
  }

  /** Points desc; equal points share a rank. */
  function computePlacements(points: Record<string, number>): {
    placements: Record<string, number>;
    topIds: string[];
  } {
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
    const { points } = scoreGrid();
    const { placements, topIds } = computePlacements(points);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const summary = winnerId
      ? `${prefix}${nickOf(winnerId)} wins with ${points[winnerId] ?? 0} pts`
      : `${prefix}it's a tie`;
    broadcastState(true);
    ctx.endMatch({ winnerId, placements, scores: points, summary });
  }

  function connectedCount(): number {
    let n = 0;
    for (const pid of connected) if (participantIds.has(pid)) n++;
    return n;
  }

  function allDone(): boolean {
    for (const pid of connected) if (!doneIds.has(pid)) return false;
    return true;
  }

  function enterReview(now: number) {
    state.phase = "review";
    state.phaseEndsAt = now + REVIEW_MS;
    state.dirty = true;
  }

  function enterResults(now: number) {
    state.phase = "results";
    state.phaseEndsAt = now + RESULTS_MS;
    state.dirty = true;
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
        return;
      }
      if (connectedCount() < 2) {
        endWith("not enough players · ");
        return;
      }
      if (now >= state.phaseEndsAt) {
        if (state.phase === "write") enterReview(now);
        else if (state.phase === "review") enterResults(now);
        else if (state.phase === "results") {
          endWith("");
          return;
        }
      }
      broadcastState();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      const now = Date.now();
      // No warm-up gate: typing during the 3-2-1 is harmless (phase timers
      // are anchored to GO anyway) and dropping it would lose answers.
      if (!participantIds.has(playerId) || !connected.has(playerId)) return;

      if (state.phase === "write") {
        if (msg.type === "answers") {
          const raw = Array.isArray(msg.answers) ? msg.answers : [];
          const clean = ["", "", "", ""];
          for (let i = 0; i < NUM_CATEGORIES; i++) {
            const v = raw[i];
            if (typeof v === "string") clean[i] = v.trim().slice(0, MAX_ANSWER_LEN);
          }
          answers.set(playerId, clean);
          // No broadcast needed — answers are private until review.
        } else if (msg.type === "done") {
          const mine = answers.get(playerId) ?? [];
          if (mine.some((a) => normalizeAnswer(a).length === 0)) return;
          if (doneIds.has(playerId)) return;
          doneIds.add(playerId);
          const base = Math.max(now, ctx.startAt);
          if (state.stopperId === null) {
            state.stopperId = playerId;
            state.phaseEndsAt = Math.min(state.phaseEndsAt, base + STOP_GRACE_MS);
          }
          if (allDone()) state.phaseEndsAt = base;
          state.dirty = true;
        }
        return;
      }

      if (state.phase === "review") {
        if (msg.type === "strike") {
          const target = msg.playerId;
          const ci = msg.ci;
          if (typeof target !== "string" || !participantIds.has(target)) return;
          if (typeof ci !== "number" || ci < 0 || ci >= NUM_CATEGORIES) return;
          const key = `${target}:${ci}`;
          if (msg.struck === false) struck.delete(key);
          else struck.add(key);
          state.dirty = true;
        } else if (msg.type === "host-next") {
          if (!ctx.isHost(playerId)) return;
          state.phaseEndsAt = now;
          state.dirty = true;
        }
      }
    },

    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!connected.has(playerId)) return;
      connected.delete(playerId);
      state.dirty = true;
      if (state.phase === "write" && allDone() && Date.now() >= ctx.startAt) {
        state.phaseEndsAt = Date.now();
      }
    },

    cleanup() {},
  };
}

const CategoriesDefinition: MiniGameDefinition = {
  id: "categories",
  displayName: "Categories",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 10,
  matchTimeoutMs: CAT_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createCategoriesMatch,
};

registerMiniGame(CategoriesDefinition);

export default CategoriesDefinition;
