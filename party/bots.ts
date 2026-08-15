// Test bots — server-side fake players for solo playtesting (test lobbies
// only, see `isTestLobbyCode` in protocol.ts).
//
// Bots have NO per-game AI. Instead they MIRROR the humans: every match
// message a human sends is re-injected under each bot's playerId a little
// later, through the exact same gamemode/match code path a real socket
// message takes. That is game-agnostic and keeps bots alive in "do nothing
// and you die" games (flappy, copter, don't-let-go…) for about as long as
// the human survives. In tournaments the bot mirrors into ITS OWN match
// (the gamemode resolves the bot's matchId), so a human-vs-bot match gives
// the human a shadow opponent.
//
// Strategies (per bot, GM-switchable from the debug panel):
//   mirror — every message, ~250ms later
//   sloppy — 70% of messages, 150–700ms later: falls behind, dies at other
//            times than the human → staggered eliminations / placements
//   idle   — nothing at all
//
// Known limits (documented in FOLLOWUP.md): bots only act while a human is
// sending inputs — once every human is dead/spectating, mirror bots go
// quiet. Secret-choice games (penalty shootout, hot bid…) see the bot pick
// what the human picked; use `sloppy`/`idle` for variety there.

import { AVATAR_ORDER } from "./avatars";
import type { BotStrategy } from "./protocol";

const BOT_NAMES = [
  "Bot Alpha",
  "Bot Bravo",
  "Bot Charlie",
  "Bot Delta",
  "Bot Echo",
  "Bot Foxtrot",
  "Bot Golf",
  "Bot Hotel",
  "Bot India",
  "Bot Juliet",
  "Bot Kilo",
  "Bot Lima",
  "Bot Mike",
  "Bot November",
  "Bot Oscar",
];

const MIRROR_DELAY_MS = 250;
const SLOPPY_PASS_RATE = 0.7;
const SLOPPY_DELAY_MIN_MS = 150;
const SLOPPY_DELAY_MAX_MS = 700;
/** Only "mirror" carries a bot through most games, but a lobby of clones
 *  never exercises staggered outcomes — alternate strategies by default. */
const DEFAULT_STRATEGY_CYCLE: readonly BotStrategy[] = ["mirror", "sloppy"];

export type BotRecord = {
  playerId: string;
  nickname: string;
  avatarId: string;
  strategy: BotStrategy;
};

export type BotInject = (
  botId: string,
  /** matchId of the HUMAN message being mirrored; the injector maps it to
   *  the bot's own match. */
  humanMatchId: string,
  msg: { type: string; [k: string]: unknown },
) => void;

export class BotManager {
  private bots = new Map<string, BotRecord>();
  private seq = 0;
  private pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(private inject: BotInject) {}

  list(): BotRecord[] {
    return [...this.bots.values()];
  }

  get(playerId: string): BotRecord | null {
    return this.bots.get(playerId) ?? null;
  }

  strategyOf(playerId: string): BotStrategy | undefined {
    return this.bots.get(playerId)?.strategy;
  }

  /** Create the next bot record (caller registers it with the registry —
   *  the registry applies its own nickname/avatar uniqueness rules). */
  create(): BotRecord {
    const i = this.seq++;
    const rec: BotRecord = {
      playerId: `bot-${i + 1}-${Math.random().toString(36).slice(2, 7)}`,
      nickname: BOT_NAMES[i % BOT_NAMES.length],
      avatarId: AVATAR_ORDER[(i + 1) % AVATAR_ORDER.length],
      strategy: DEFAULT_STRATEGY_CYCLE[i % DEFAULT_STRATEGY_CYCLE.length],
    };
    this.bots.set(rec.playerId, rec);
    return rec;
  }

  /** Remove a specific bot, or the most recently added one. */
  remove(playerId?: string): BotRecord | null {
    const target = playerId
      ? this.bots.get(playerId)
      : [...this.bots.values()].at(-1);
    if (!target) return null;
    this.bots.delete(target.playerId);
    return target;
  }

  setStrategy(playerId: string, strategy: BotStrategy): boolean {
    const b = this.bots.get(playerId);
    if (!b) return false;
    b.strategy = strategy;
    return true;
  }

  /** A human participant sent a match message — schedule the mirrors. */
  onHumanMatchMessage(
    humanMatchId: string,
    msg: { type: string; [k: string]: unknown },
  ) {
    for (const bot of this.bots.values()) {
      let delay: number;
      if (bot.strategy === "mirror") {
        delay = MIRROR_DELAY_MS;
      } else if (bot.strategy === "sloppy") {
        if (Math.random() > SLOPPY_PASS_RATE) continue;
        delay =
          SLOPPY_DELAY_MIN_MS +
          Math.random() * (SLOPPY_DELAY_MAX_MS - SLOPPY_DELAY_MIN_MS);
      } else {
        continue; // idle
      }
      const botId = bot.playerId;
      const handle = setTimeout(() => {
        this.pending.delete(handle);
        // Bot may have been removed meanwhile.
        if (!this.bots.has(botId)) return;
        this.inject(botId, humanMatchId, msg);
      }, delay);
      this.pending.add(handle);
    }
  }

  /** Drop every scheduled mirror (round ended / lobby reset). */
  clearPending() {
    for (const h of this.pending) clearTimeout(h);
    this.pending.clear();
  }
}
