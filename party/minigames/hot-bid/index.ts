// Hot Bid — last-man-standing FFA sealed-bid auction. Everyone starts with
// 100 coins; 8 prize cards (a fixed shuffled deck of point values
// 2,3,4,5,6,7,8,10) are auctioned one at a time. Per card: a 12s secret
// bidding phase (stepper + lock in; broadcasts carry only WHO locked, never
// amounts — own bid travels via sendTo), then a 5s reveal phase showing all
// bids. Highest bid wins the card and pays their bid; ties → random winner
// among tied; an all-zero card is discarded (nobody pays). After 8 cards:
// placements by points desc, tiebreak leftover coins desc, identical
// points+coins share a rank (shared rank 1 → winnerId null).
//
// Disconnects: their current bid stands for the live card, then they simply
// stop bidding — no forfeit, they keep ranking by the same economy rules.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const START_COINS = 100;
const CARD_VALUES = [2, 3, 4, 5, 6, 7, 8, 10];
/** Crew sprite per point value — sprite+value are always public. */
const SPRITE_BY_VALUE: Record<number, string> = {
  10: "money_bag",
  8: "coin",
  7: "star",
  6: "heart",
  5: "cake",
  4: "meat",
  3: "mushroom",
  2: "onion",
};
const BID_MS = 12_000;
const REVEAL_MS = 5_000;
/** sendTo is not replayed on reconnect — re-send own-bid secrets this often. */
const SECRET_RESEND_MS = 500;
/** 8 cards × (12s bid + 5s reveal) = 136s max; safety net just above. */
const HB_MATCH_TIMEOUT_MS = 150_000;

type Phase = "bidding" | "reveal" | "ended";

type Econ = {
  coins: number;
  points: number;
  cardsWon: number;
  left: boolean;
};

type Bid = { amount: number; locked: boolean };

type Reveal = {
  cardIndex: number;
  value: number;
  sprite: string;
  /** All bids, sorted amount desc. Public only from the reveal phase on. */
  bids: { playerId: string; amount: number }[];
  winnerId: string | null;
  tie: boolean;
  discarded: boolean;
  note: string;
};

type GameState = {
  phase: Phase;
  deck: { value: number; sprite: string }[];
  cardIndex: number;
  phaseEndsAt: number;
  bids: Map<string, Bid>;
  econ: Map<string, Econ>;
  lastReveal: Reveal | null;
  lastSecretAt: number;
  ended: boolean;
};

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function createHotBidMatch(ctx: MatchContext): MatchSession {
  const players = ctx.players;

  const deckValues = [...CARD_VALUES];
  shuffleInPlace(deckValues);

  const state: GameState = {
    phase: "bidding",
    deck: deckValues.map((v) => ({ value: v, sprite: SPRITE_BY_VALUE[v] })),
    cardIndex: 0,
    // Card 1's bidding window anchors to GO, not creation (warm-up).
    phaseEndsAt: ctx.startAt + BID_MS,
    bids: new Map(players.map((p) => [p.playerId, { amount: 0, locked: false }])),
    econ: new Map(
      players.map((p) => [
        p.playerId,
        { coins: START_COINS, points: 0, cardsWon: 0, left: false },
      ]),
    ),
    lastReveal: null,
    lastSecretAt: 0,
    ended: false,
  };

  ctx.broadcast({
    type: "welcome",
    startCoins: START_COINS,
    totalCards: state.deck.length,
    bidMs: BID_MS,
    revealMs: REVEAL_MS,
    startAt: ctx.startAt,
    deadlineAt: ctx.deadlineAt,
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  function currentCard() {
    return state.deck[Math.min(state.cardIndex, state.deck.length - 1)];
  }

  function broadcastState() {
    const locked: Record<string, boolean> = {};
    const coins: Record<string, number> = {};
    const points: Record<string, number> = {};
    const left: Record<string, boolean> = {};
    for (const p of players) {
      locked[p.playerId] = state.bids.get(p.playerId)?.locked ?? false;
      const e = state.econ.get(p.playerId)!;
      coins[p.playerId] = e.coins;
      points[p.playerId] = e.points;
      left[p.playerId] = e.left;
    }
    const card = currentCard();
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      cardIndex: state.cardIndex,
      totalCards: state.deck.length,
      card: { value: card.value, sprite: card.sprite },
      phaseEndsAt: state.phaseEndsAt,
      // SECRECY: during bidding only lock booleans go out — never amounts.
      locked,
      coins,
      points,
      left,
      // Bid amounts become public only from the reveal phase on.
      reveal: state.phase === "bidding" ? null : state.lastReveal,
      deadlineAt: ctx.deadlineAt,
    });
  }

  /** Own bid is private info → sendTo, re-sent periodically so reconnecting
   *  players resync (sendTo is not replayed). Applied idempotently client-side. */
  function sendSecrets() {
    for (const p of players) {
      const b = state.bids.get(p.playerId);
      if (!b) continue;
      ctx.sendTo(p.playerId, {
        type: "yourBid",
        cardIndex: state.cardIndex,
        amount: b.amount,
        locked: b.locked,
      });
    }
  }

  function resolveCard() {
    const card = currentCard();
    // Bids are clamped to coins on arrival AND re-clamped here — audited
    // after a playtest report of an over-bid (couldn't be reproduced; the
    // likely sighting was the reveal showing a winning bid next to the
    // already-debited balance). This keeps the invariant airtight either way.
    const entries = players.map((p) => ({
      playerId: p.playerId,
      amount: Math.min(
        state.bids.get(p.playerId)?.amount ?? 0,
        state.econ.get(p.playerId)?.coins ?? 0,
      ),
    }));
    entries.sort((a, b) => b.amount - a.amount);
    const maxBid = entries[0]?.amount ?? 0;

    let winnerId: string | null = null;
    let tie = false;
    let discarded = false;
    let note = "";
    if (maxBid <= 0) {
      // Nobody bid — card is discarded, nobody pays, no points awarded.
      discarded = true;
      note = "nobody bid · card discarded";
    } else {
      const tied = entries.filter((e) => e.amount === maxBid);
      tie = tied.length > 1;
      winnerId = tied[Math.floor(Math.random() * tied.length)].playerId;
      const winner = state.econ.get(winnerId)!;
      winner.coins = Math.max(0, winner.coins - maxBid);
      winner.points += card.value;
      winner.cardsWon += 1;
      const nick = players.find((p) => p.playerId === winnerId)?.nickname ?? "?";
      note = tie
        ? `${tied.length}-way tie at ${maxBid} · random pick: ${nick}`
        : `${nick} pays ${maxBid}`;
    }

    state.lastReveal = {
      cardIndex: state.cardIndex,
      value: card.value,
      sprite: card.sprite,
      bids: entries,
      winnerId,
      tie,
      discarded,
      note,
    };
    state.phase = "reveal";
    state.phaseEndsAt = Date.now() + REVEAL_MS;
  }

  function nextCard() {
    state.cardIndex += 1;
    if (state.cardIndex >= state.deck.length) {
      endByCardsDone();
      return;
    }
    for (const b of state.bids.values()) {
      b.amount = 0;
      b.locked = false;
    }
    state.lastReveal = null;
    state.phase = "bidding";
    state.phaseEndsAt = Math.max(Date.now(), ctx.startAt) + BID_MS;
  }

  /** Points desc, tiebreak leftover coins desc; identical points AND coins
   *  share a rank. */
  function computePlacements(): Record<string, number> {
    const entries = players.map((p) => {
      const e = state.econ.get(p.playerId)!;
      return { playerId: p.playerId, points: e.points, coins: e.coins };
    });
    entries.sort((a, b) => b.points - a.points || b.coins - a.coins);
    const out: Record<string, number> = {};
    let rank = 1;
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (
        j < entries.length &&
        entries[j].points === entries[i].points &&
        entries[j].coins === entries[i].coins
      )
        j++;
      for (let g = i; g < j; g++) out[entries[g].playerId] = rank;
      rank += j - i;
      i = j;
    }
    return out;
  }

  function endWith(summaryPrefix: string | null) {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const placements = computePlacements();
    const topIds = Object.entries(placements)
      .filter(([, r]) => r === 1)
      .map(([id]) => id);
    // Shared rank 1 (same points AND same coins) is an honest tie.
    const winnerId = topIds.length === 1 ? topIds[0] : null;
    const scores: Record<string, number> = {};
    for (const p of players) scores[p.playerId] = state.econ.get(p.playerId)!.points;
    let summary: string;
    if (winnerId) {
      const e = state.econ.get(winnerId)!;
      const nick = players.find((p) => p.playerId === winnerId)?.nickname ?? "?";
      summary = `${nick} wins · ${e.points} pts · ${e.coins} coins left`;
    } else {
      summary = `${topIds.length}-way tie at the top`;
    }
    if (summaryPrefix) summary = `${summaryPrefix} · ${summary}`;
    broadcastState();
    ctx.endMatch({ winnerId, placements, scores, summary });
  }

  function endByCardsDone() {
    endWith(null);
  }

  function endByDeadline() {
    endWith("time's up");
  }

  return {
    tick() {
      if (state.ended) return;
      if (Date.now() >= ctx.deadlineAt) {
        endByDeadline();
        return;
      }
      const now = Date.now();
      if (now < ctx.startAt) {
        // Warm-up: clients render the frozen card-1 scene; timers don't run.
        broadcastState();
        return;
      }
      if (state.phase === "bidding") {
        if (now - state.lastSecretAt >= SECRET_RESEND_MS) {
          state.lastSecretAt = now;
          sendSecrets();
        }
        if (now >= state.phaseEndsAt) {
          // Unlocked bids count as-is (default 0).
          resolveCard();
        }
      } else if (state.phase === "reveal") {
        if (now >= state.phaseEndsAt) {
          nextCard();
          if (state.ended) return;
        }
      }
      broadcastState();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      if (Date.now() < ctx.startAt) return; // warm-up: ignore inputs
      const econ = state.econ.get(playerId);
      const bid = state.bids.get(playerId);
      if (!econ || !bid) return; // not a participant
      // Any message from a player marked left = they reconnected.
      econ.left = false;
      if (state.phase !== "bidding") return;
      if (msg.type === "bid") {
        if (bid.locked) return; // frozen until reveal
        const raw = msg.amount;
        if (typeof raw !== "number" || !Number.isFinite(raw)) return;
        const amount = Math.round(raw);
        bid.amount = Math.max(0, Math.min(econ.coins, amount));
      } else if (msg.type === "lock") {
        bid.locked = true;
      }
    },

    onPlayerLeft(playerId) {
      if (state.ended) return;
      const econ = state.econ.get(playerId);
      if (!econ) return;
      // No forfeit — an economy game keeps their standing. Their current bid
      // stands for the live card; they just stop bidding afterwards.
      econ.left = true;
    },

    cleanup() {},
  };
}

const HotBidDefinition: MiniGameDefinition = {
  id: "hot-bid",
  displayName: "Hot Bid",
  gamemode: "last-man-standing",
  matchSize: 16,
  minPlayers: 2,
  maxPlayers: 16,
  orientation: "portrait",
  tickHz: 30,
  matchTimeoutMs: HB_MATCH_TIMEOUT_MS,
  shuffleWeight: 2,
  createMatch: createHotBidMatch,
};

registerMiniGame(HotBidDefinition);

export default HotBidDefinition;
