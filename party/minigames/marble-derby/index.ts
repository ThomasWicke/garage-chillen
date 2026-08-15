// Marble Race — last-man-standing FFA betting spectacle. Nobody steers
// anything: six fixed crew-character marbles (the "horses") drop through a
// plinko peg board; everyone bets on a racer, watches the chaos live, and
// scores points when their pick places. ONE race (playtest: two dragged).
//
// Phases (tick-driven): betting (12s) → race (physics, ≤45s) → results (6s). Bets are secret during betting (only WHO has bet is broadcast; the
// actual picks are revealed at race start).

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

export const MDBY_FIELD_W = 500;
export const MDBY_FIELD_H = 880;
export const MDBY_PEG_RADIUS = 7;
export const MDBY_MARBLE_RADIUS = 13;
export const MDBY_FINISH_Y = 800;

/** The six racers, fixed crew characters — clients map these keys to
 *  @kaplayjs/crew sprites. Order = racer index 0..5. */
export const MDBY_RACERS = ["bean", "ghosty", "mark", "kat", "bag", "bobo"];

const NUM_RACERS = 6;
const NUM_RACES = 1;
const BETTING_MS = 12_000;
const RESULTS_MS = 6_000;
const RACE_CAP_MS = 45_000;
/** After the winner crosses, keep simulating this long to record 2nd. */
const SECOND_PLACE_WINDOW_MS = 3_000;
const WIN_POINTS = 3;
const SECOND_POINTS = 1;

// Floaty on purpose (playtest: "over too quickly, wants spectacular
// bounces"). Tuned with an offline replica of stepPhysics over 200 races:
// the old 500/500/0.75 on 8 rows had the winner crossing at a 3.6s median;
// this (14 rows × 7 cols) gives ~11s median, 7–19s range, no stalls.
const GRAVITY = 120;
const MAX_FALL_SPEED = 130;
const RESTITUTION = 0.88;
/** Random tangent kick on peg bounces so runs diverge. */
const TANGENT_JITTER = 70;
/** Re-send each player's own (secret) bet this often during betting so a
 *  reconnect mid-betting restores their highlighted pick. */
const SECRET_RESEND_MS = 500;

/** 12s betting + ≤45s race + 6s results = 63s max; safety net just above. */
const MDBY_MATCH_TIMEOUT_MS = 75_000;

type Peg = { x: number; y: number };

type Marble = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Crossed the finish line (recorded once). */
  crossed: boolean;
};

type Phase = "betting" | "race" | "results";

type RaceResult = {
  raceIndex: number;
  winner: number;
  second: number;
  /** Full finish order, racer indices best→worst — so every bettor can see
   *  exactly where their pick landed, not just 1st/2nd. */
  order: number[];
};

type State = {
  phase: Phase;
  raceIndex: number; // 0 or 1
  phaseEndsAt: number; // betting / results end (0 during race)
  marbles: Marble[];
  /** Bets per race: playerId -> racer index 0..5. */
  bets: Map<string, number>[];
  points: Map<string, number>;
  raceStartedAt: number;
  raceCapAt: number;
  /** Finish-cross order of racer indices this race. */
  crossedOrder: number[];
  winnerCrossedAt: number;
  lastResult: RaceResult | null;
  lastSecretSendAt: number;
  ended: boolean;
};

const PEG_COLS = 7;
const PEG_ROW_STEP = 50;

function buildPegs(): Peg[] {
  const pegs: Peg[] = [];
  const gap = MDBY_FIELD_W / PEG_COLS; // ~71px; marbles are 26px wide
  let rowIdx = 0;
  // 14 rows, 110..760 — the finish line is at 800.
  for (let y = 110; y <= 760; y += PEG_ROW_STEP) {
    if (rowIdx % 2 === 0) {
      for (let i = 0; i < PEG_COLS; i++) pegs.push({ x: gap / 2 + i * gap, y });
    } else {
      // Offset half a column, plus wall pegs at 10/490 — without them a
      // marble can hug the wall corridor past every peg, and the two edge
      // lanes win far more often than the middle (bad betting odds).
      pegs.push({ x: 10, y });
      for (let i = 0; i < PEG_COLS - 1; i++) pegs.push({ x: gap + i * gap, y });
      pegs.push({ x: MDBY_FIELD_W - 10, y });
    }
    rowIdx++;
  }
  return pegs;
}

function createMarbleDerbyMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const pegs = buildPegs();

  const state: State = {
    phase: "betting",
    raceIndex: 0,
    // Race-1 betting anchors to GO, not creation (warm-up must not eat it).
    phaseEndsAt: ctx.startAt + BETTING_MS,
    marbles: [],
    bets: [new Map(), new Map()],
    points: new Map(players.map((p) => [p.playerId, 0])),
    raceStartedAt: 0,
    raceCapAt: 0,
    crossedOrder: [],
    winnerCrossedAt: 0,
    lastResult: null,
    lastSecretSendAt: 0,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    field: { w: MDBY_FIELD_W, h: MDBY_FIELD_H },
    pegs,
    pegRadius: MDBY_PEG_RADIUS,
    marbleRadius: MDBY_MARBLE_RADIUS,
    finishY: MDBY_FINISH_Y,
    racers: MDBY_RACERS,
    races: NUM_RACES,
    bettingMs: BETTING_MS,
    resultsMs: RESULTS_MS,
    winPoints: WIN_POINTS,
    secondPoints: SECOND_POINTS,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function dropMarbles() {
    state.marbles = [];
    const slotW = MDBY_FIELD_W / NUM_RACERS;
    for (let i = 0; i < NUM_RACERS; i++) {
      state.marbles.push({
        x: (i + 0.5) * slotW + (Math.random() - 0.5) * 16,
        y: 30,
        vx: (Math.random() - 0.5) * 40,
        vy: 0,
        crossed: false,
      });
    }
    state.crossedOrder = [];
    state.winnerCrossedAt = 0;
  }

  function stepPhysics(dt: number) {
    const r = MDBY_MARBLE_RADIUS;
    for (const m of state.marbles) {
      m.vy += GRAVITY * dt;
      if (m.vy > MAX_FALL_SPEED) m.vy = MAX_FALL_SPEED;
      m.x += m.vx * dt;
      m.y += m.vy * dt;

      // Side walls.
      if (m.x < r) {
        m.x = r;
        m.vx = Math.abs(m.vx) * RESTITUTION;
      } else if (m.x > MDBY_FIELD_W - r) {
        m.x = MDBY_FIELD_W - r;
        m.vx = -Math.abs(m.vx) * RESTITUTION;
      }
      // Floor (marbles pile up below the finish line).
      if (m.y > MDBY_FIELD_H - r) {
        m.y = MDBY_FIELD_H - r;
        m.vy = -Math.abs(m.vy) * 0.3;
      }

      // Pegs: circle-vs-circle bounce.
      for (const p of pegs) {
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        const minDist = r + MDBY_PEG_RADIUS;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        // Push out of the peg.
        m.x = p.x + nx * minDist;
        m.y = p.y + ny * minDist;
        const vn = m.vx * nx + m.vy * ny;
        if (vn < 0) {
          // Reflect about the contact normal with restitution, plus a small
          // random tangent kick so runs diverge.
          m.vx -= (1 + RESTITUTION) * vn * nx;
          m.vy -= (1 + RESTITUTION) * vn * ny;
          const jitter = (Math.random() - 0.5) * TANGENT_JITTER;
          m.vx += -ny * jitter;
          m.vy += nx * jitter;
        }
      }
    }

    // Marble-vs-marble light separation.
    for (let i = 0; i < state.marbles.length; i++) {
      for (let j = i + 1; j < state.marbles.length; j++) {
        const a = state.marbles[i];
        const b = state.marbles[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDist = r * 2;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) continue;
        let nx: number;
        let ny: number;
        let d: number;
        if (d2 === 0) {
          nx = 1;
          ny = 0;
          d = 0;
        } else {
          d = Math.sqrt(d2);
          nx = dx / d;
          ny = dy / d;
        }
        const push = (minDist - d) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        // Light velocity response if approaching.
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn < 0) {
          const impulse = -rvn * 0.5 * 0.6; // light, inelastic
          a.vx -= nx * impulse;
          a.vy -= ny * impulse;
          b.vx += nx * impulse;
          b.vy += ny * impulse;
        }
      }
    }

    // Record finish-line crossings in order.
    for (let i = 0; i < state.marbles.length; i++) {
      const m = state.marbles[i];
      if (!m.crossed && m.y > MDBY_FINISH_Y) {
        m.crossed = true;
        state.crossedOrder.push(i);
        if (state.crossedOrder.length === 1) {
          state.winnerCrossedAt = Date.now();
        }
      }
    }
  }

  /** Racer indices sorted by current progress (lowest on board = leader). */
  function leaderOrder(): number[] {
    const idx = state.marbles.map((_, i) => i);
    idx.sort((a, b) => state.marbles[b].y - state.marbles[a].y);
    return idx;
  }

  function startBetting(nowMs: number) {
    state.phase = "betting";
    state.marbles = [];
    state.phaseEndsAt = nowMs + BETTING_MS;
  }

  function startRace() {
    state.phase = "race";
    state.phaseEndsAt = 0;
    const now = Date.now();
    state.raceStartedAt = now;
    state.raceCapAt = now + RACE_CAP_MS;
    dropMarbles();
  }

  /** Full finish order: crossers in crossing order, then everyone else by
   *  current board position (lower = further along = better). */
  function fullOrder(): number[] {
    const crossed = [...state.crossedOrder];
    const rest = leaderOrder().filter((i) => !crossed.includes(i));
    return [...crossed, ...rest];
  }

  function finishRace(order: number[]) {
    const winner = order[0];
    const second = order[1];
    const bets = state.bets[state.raceIndex];
    for (const [pid, racer] of bets) {
      if (racer === winner) {
        state.points.set(pid, (state.points.get(pid) ?? 0) + WIN_POINTS);
      } else if (racer === second) {
        state.points.set(pid, (state.points.get(pid) ?? 0) + SECOND_POINTS);
      }
    }
    state.lastResult = { raceIndex: state.raceIndex, winner, second, order };
    state.phase = "results";
    state.phaseEndsAt = Date.now() + RESULTS_MS;
  }

  function computePlacements(): Record<string, number> {
    type Entry = { playerId: string; pts: number };
    const entries: Entry[] = players.map((p) => ({
      playerId: p.playerId,
      pts: state.points.get(p.playerId) ?? 0,
    }));
    entries.sort((a, b) => b.pts - a.pts);
    // Grouped shared ranks: equal points share a rank.
    const out: Record<string, number> = {};
    let rank = 1;
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (j < entries.length && entries[j].pts === entries[i].pts) j++;
      for (let g = i; g < j; g++) out[entries[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    return out;
  }

  function endByPoints(reason: "final" | "deadline") {
    if (state.ended) return;
    state.ended = true;
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const topPts = winnerId !== null ? (state.points.get(winnerId) ?? 0) : 0;
    const winnerNick = winnerId
      ? (players.find((p) => p.playerId === winnerId)?.nickname ?? "?")
      : null;
    const scoresObj: Record<string, number> = {};
    for (const [pid, s] of state.points) scoresObj[pid] = s;
    broadcastState();
    ctx.endMatch({
      winnerId,
      placements,
      scores: scoresObj,
      summary:
        winnerId !== null
          ? `${winnerNick} wins · ${topPts} pts${reason === "deadline" ? " · time's up" : ""}`
          : topIds.length > 1
            ? `tie at the top · ${topIds.length} way`
            : "no winner",
    });
  }

  function broadcastState() {
    const pointsObj: Record<string, number> = {};
    for (const [pid, s] of state.points) pointsObj[pid] = s;
    const bets = state.bets[state.raceIndex];
    const msg: { type: string; [k: string]: unknown } = {
      type: "state",
      phase: state.phase,
      raceIndex: state.raceIndex,
      phaseEndsAt: state.phaseEndsAt,
      marbles: state.marbles.map((m) => ({
        x: Math.round(m.x),
        y: Math.round(m.y),
      })),
      points: pointsObj,
      lastResult: state.lastResult,
      deadlineAt: ctx.deadlineAt,
    };
    if (state.phase === "betting") {
      // Secret picks: broadcast only WHO has bet, not on which racer.
      msg.hasBet = [...bets.keys()];
    } else {
      // Reveal at race start; stays visible through results.
      const betsObj: Record<string, number> = {};
      for (const [pid, racer] of bets) betsObj[pid] = racer;
      msg.bets = betsObj;
    }
    ctx.broadcast(msg);
  }

  /** Re-send each bettor their own secret pick (reconnect-safe). */
  function resendSecrets() {
    const now = Date.now();
    if (now - state.lastSecretSendAt < SECRET_RESEND_MS) return;
    state.lastSecretSendAt = now;
    const bets = state.bets[state.raceIndex];
    for (const [pid, racer] of bets) {
      ctx.sendTo(pid, {
        type: "your-bet",
        raceIndex: state.raceIndex,
        racer,
      });
    }
  }

  return {
    tick(dt: number) {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByPoints("deadline");
        return;
      }
      if (Date.now() < ctx.startAt) {
        // Warm-up: frozen scene, timers anchored to startAt already.
        broadcastState();
        return;
      }
      const now = Date.now();

      if (state.phase === "betting") {
        resendSecrets();
        if (now >= state.phaseEndsAt) {
          startRace();
        }
      } else if (state.phase === "race") {
        stepPhysics(dt);
        if (state.crossedOrder.length >= 2) {
          finishRace(fullOrder());
        } else if (
          state.crossedOrder.length === 1 &&
          now - state.winnerCrossedAt >= SECOND_PLACE_WINDOW_MS
        ) {
          // Nobody else crossed in the window: rest rank by board position.
          finishRace(fullOrder());
        } else if (now >= state.raceCapAt) {
          // Hard cap: leader (lowest marble) decides the whole order.
          finishRace(fullOrder());
        }
      } else if (state.phase === "results") {
        if (now >= state.phaseEndsAt) {
          if (state.raceIndex + 1 < NUM_RACES) {
            state.raceIndex += 1;
            startBetting(now);
          } else {
            endByPoints("final");
            return;
          }
        }
      }

      if (state.ended) return;
      broadcastState();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      if (state.phase !== "betting") return; // bets only during betting
      if (msg.type !== "bet") return;
      if (!players.some((p) => p.playerId === playerId)) return;
      const racer = msg.racer;
      if (typeof racer !== "number" || !Number.isFinite(racer)) return;
      const idx = Math.floor(racer);
      if (idx < 0 || idx >= NUM_RACERS) return;
      // Changeable until the betting phase ends.
      state.bets[state.raceIndex].set(playerId, idx);
    },

    onPlayerLeft() {
      // Bets stand; points ordering handles final ranking. No forfeit rank.
    },

    cleanup() {},
  };
}

const MarbleDerbyDefinition: MiniGameDefinition = {
  // id stays "marble-derby" (wire/registry identity); the display name is
  // what players see.
  id: "marble-derby",
  displayName: "Marble Race",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: MDBY_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createMarbleDerbyMatch,
};

registerMiniGame(MarbleDerbyDefinition);

export default MarbleDerbyDefinition;
