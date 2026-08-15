// Who Am I? — the sticky-note-on-the-forehead game, played IN THE ROOM.
// Last-man-standing (everyone in one match). Two registry entries share
// this module:
//   who-am-i         curated: identities are dealt from a ~110-name list
//   who-am-i-custom  custom:  everyone first WRITES an identity for the
//                             player next to them (ring), then plays
//
// Your phone shows everyone ELSE's identity and "you: ???". You ask yes/no
// questions out loud IN TURN — the active player's phone has a NEXT PLAYER
// button and it's on them to pass it (turn skips solved / gone players);
// the room answers out loud. When you say your guess
// and the room says "yes", ANY OTHER player taps ✓ on your tile — no
// answer-matching, no voting, the phone just records the room's verdict.
// (Tap again to undo a mis-tap.)
//
// Phases:
//   write   (custom only, ≤45s) type an identity for your target; all in →
//                               straight on. Empty → curated fallback.
//   play    (≤4min)             identities dealt (per-player `board`, never
//                               broadcast). Ends when everyone is solved, or
//                               30s after only one player is left guessing.
//   results (8s)                everyone's identity + solve order.
// Placement = solve order; unsolved share last. LMS points 10/5/3/1.

import { registerMiniGame } from "../registry";
import type {
  MatchContext,
  MatchSession,
  MiniGameDefinition,
} from "../types";

const WRITE_MS = 45_000;
const PLAY_MS = 240_000;
const LAST_ONE_GRACE_MS = 30_000;
const RESULTS_MS = 8_000;
const HEARTBEAT_MS = 500;
const BOARD_RESEND_MS = 1_000;
const MAX_IDENTITY_LEN = 30;

const CURATED: readonly string[] = [
  // fictional
  "Harry Potter", "Hermione Granger", "Voldemort", "Dumbledore", "Darth Vader",
  "Yoda", "Han Solo", "Chewbacca", "Batman", "The Joker", "Spider-Man",
  "Superman", "Wonder Woman", "Iron Man", "The Hulk", "Thor", "Deadpool",
  "Wolverine", "Groot", "Sherlock Holmes", "James Bond", "Indiana Jones",
  "Shrek", "Homer Simpson", "Bart Simpson", "SpongeBob", "Mickey Mouse",
  "Donald Duck", "Winnie the Pooh", "Pikachu", "Super Mario", "Luigi",
  "Princess Peach", "Sonic the Hedgehog", "Lara Croft", "Elsa (Frozen)",
  "Simba", "Nemo", "Buzz Lightyear", "Woody (Toy Story)", "Kermit the Frog",
  "Gollum", "Gandalf", "Frodo", "Captain Jack Sparrow", "Forrest Gump",
  "Rocky Balboa", "The Terminator", "Godzilla", "King Kong", "Dracula",
  "Frankenstein's monster", "Santa Claus", "The Easter Bunny",
  "Pippi Longstocking", "Asterix", "Obelix", "Garfield", "Scooby-Doo",
  "Tarzan", "Robin Hood", "Peter Pan", "Cinderella", "Snow White",
  "Pinocchio", "Aladdin", "Barbie", "Mr. Bean", "Rambo", "Walter White",
  "Jon Snow", "Harley Quinn", "Catwoman", "Minions (Kevin)", "Mulan",
  // real
  "Albert Einstein", "Isaac Newton", "Leonardo da Vinci", "Cleopatra",
  "Napoleon", "Julius Caesar", "Queen Elizabeth II", "Barack Obama",
  "Angela Merkel", "Elon Musk", "Bill Gates", "Steve Jobs", "Mark Zuckerberg",
  "Michael Jackson", "Elvis Presley", "Madonna", "Beyoncé", "Taylor Swift",
  "Rihanna", "Lady Gaga", "Ed Sheeran", "Freddie Mercury", "John Lennon",
  "Bob Marley", "Eminem", "Snoop Dogg", "Cristiano Ronaldo", "Lionel Messi",
  "Michael Jordan", "Serena Williams", "Usain Bolt", "Muhammad Ali",
  "Roger Federer", "Lewis Hamilton", "Michael Schumacher", "Tiger Woods",
  "Arnold Schwarzenegger", "Tom Cruise", "Brad Pitt", "Angelina Jolie",
  "Leonardo DiCaprio", "Johnny Depp", "Will Smith", "Dwayne Johnson",
  "Keanu Reeves", "Marilyn Monroe", "Charlie Chaplin", "Charles Darwin",
  "Mozart", "Beethoven", "Picasso", "Vincent van Gogh", "Shakespeare",
  "Gandhi", "Nelson Mandela", "Martin Luther King", "Abraham Lincoln",
  "Christopher Columbus", "Neil Armstrong", "Marie Curie", "Stephen Hawking",
  "Gordon Ramsay", "Oprah Winfrey", "Kim Kardashian", "Greta Thunberg",
  "The Pope", "The Dalai Lama", "Mona Lisa", "Bruce Lee", "Jackie Chan",
];

type Phase = "write" | "play" | "results" | "ended";

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function createWhoAmIMatch(custom: boolean, ctx: MatchContext): MatchSession {
  const players = ctx.players;
  const participantIds = new Set(players.map((p) => p.playerId));
  const connected = new Set(players.map((p) => p.playerId));
  const n = players.length;

  /** Custom: writer → the player they write for (ring). */
  const writeFor = new Map<string, string>();
  const writerOf = new Map<string, string>();
  if (custom) {
    for (let i = 0; i < n; i++) {
      const w = players[i].playerId;
      const t = players[(i + 1) % n].playerId;
      writeFor.set(w, t);
      writerOf.set(t, w);
    }
  }
  /** Final submissions (count for the early finish). */
  const written = new Map<string, string>();
  /** In-progress text, used as a fallback if the phase ends mid-typing. */
  const drafts = new Map<string, string>();
  const identities = new Map<string, string>();
  const solvedOrder: string[] = [];
  /** Whose turn it is to ask (null until play / when nobody's left). */
  let turnId: string | null = null;

  const state = {
    phase: (custom ? "write" : "play") as Phase,
    phaseEndsAt: ctx.startAt + (custom ? WRITE_MS : PLAY_MS),
    playEndsAt: custom ? 0 : ctx.startAt + PLAY_MS,
    lastOneGraceEndsAt: null as number | null,
    ended: false,
    dirty: true,
    lastSentAt: 0,
    boardDirty: true,
    lastBoardAt: 0,
  };

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  ctx.broadcast({
    type: "welcome",
    deadlineAt: ctx.deadlineAt,
    startAt: ctx.startAt,
    custom,
    phaseDurations: { write: WRITE_MS, play: PLAY_MS, results: RESULTS_MS },
    players: players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    })),
  });

  // Curated: no write phase — deal right away (anchored to GO).
  if (!custom) {
    dealIdentities();
    passTurn(players[Math.floor(Math.random() * players.length)]?.playerId ?? null);
  }

  function dealIdentities() {
    const pool = [...CURATED];
    shuffleInPlace(pool);
    let k = 0;
    for (const p of players) {
      const w = custom ? writerOf.get(p.playerId) : undefined;
      const text = w ? (written.get(w) ?? drafts.get(w) ?? "").trim() : "";
      identities.set(p.playerId, text.length > 0 ? text : pool[k++ % pool.length]);
    }
  }

  /** Still guessing and still here — the only ones who get a turn. */
  function isAskable(pid: string): boolean {
    return connected.has(pid) && !solvedOrder.includes(pid);
  }

  /** Pass the turn to the next askable player after `from` (ring order). */
  function passTurn(from: string | null) {
    const ids = players.map((p) => p.playerId);
    const start = from ? ids.indexOf(from) : -1;
    for (let k = 1; k <= ids.length; k++) {
      const pid = ids[(start + k) % ids.length];
      if (isAskable(pid)) {
        turnId = pid;
        state.dirty = true;
        return;
      }
    }
    turnId = null;
    state.dirty = true;
  }

  /** The current turn holder got solved / left → move on from their seat. */
  function ensureTurnValid() {
    if (turnId !== null && isAskable(turnId)) return;
    passTurn(turnId);
  }

  function enterPlay(now: number) {
    dealIdentities();
    state.phase = "play";
    passTurn(players[Math.floor(Math.random() * players.length)]?.playerId ?? null);
    state.playEndsAt = now + PLAY_MS;
    state.phaseEndsAt = state.playEndsAt;
    state.dirty = true;
    state.boardDirty = true;
  }

  function enterResults(now: number) {
    state.phase = "results";
    state.phaseEndsAt = now + RESULTS_MS;
    state.dirty = true;
  }

  function unsolvedConnected(): string[] {
    return [...connected].filter((pid) => !solvedOrder.includes(pid));
  }

  /** Re-derive play-phase end: all solved → now; one left → 30s grace. */
  function recomputePlayEnd(now: number) {
    if (state.phase !== "play") return;
    const left = unsolvedConnected();
    if (left.length === 0) {
      state.phaseEndsAt = now;
      state.dirty = true;
      return;
    }
    if (left.length === 1) {
      if (state.lastOneGraceEndsAt === null) {
        state.lastOneGraceEndsAt = now + LAST_ONE_GRACE_MS;
      }
      state.phaseEndsAt = Math.min(state.playEndsAt, state.lastOneGraceEndsAt);
    } else {
      state.lastOneGraceEndsAt = null;
      state.phaseEndsAt = state.playEndsAt;
    }
    state.dirty = true;
  }

  function broadcastState(force = false) {
    const now = Date.now();
    if (!force && !state.dirty && now - state.lastSentAt < HEARTBEAT_MS) return;
    state.dirty = false;
    state.lastSentAt = now;
    const reveal = state.phase === "results" || state.phase === "ended";
    ctx.broadcast({
      type: "state",
      phase: state.phase,
      phaseEndsAt: state.phaseEndsAt,
      deadlineAt: ctx.deadlineAt,
      custom,
      writtenIds: custom ? [...written.keys()] : [],
      solvedOrder: [...solvedOrder],
      turnId: state.phase === "play" ? turnId : null,
      lastOneId:
        state.phase === "play" && state.lastOneGraceEndsAt !== null
          ? (unsolvedConnected()[0] ?? null)
          : null,
      connected: [...connected],
      // Identities are per-player secrets until results.
      revealed: reveal ? Object.fromEntries(identities) : null,
      writers: reveal && custom ? Object.fromEntries(writerOf) : null,
    });
  }

  /** Per-player board: everyone else's identity (never your own) — plus,
   *  during the custom write phase, who you're writing for. Sent on change
   *  and re-sent every second (sendTo isn't replayed on reconnect). */
  function sendBoards(force = false) {
    const now = Date.now();
    if (!force && !state.boardDirty && now - state.lastBoardAt < BOARD_RESEND_MS) return;
    state.boardDirty = false;
    state.lastBoardAt = now;
    for (const pid of connected) {
      const others: Record<string, string> = {};
      if (state.phase === "play" || state.phase === "results" || state.phase === "ended") {
        for (const [id, text] of identities) {
          if (id !== pid) others[id] = text;
        }
      }
      ctx.sendTo(pid, {
        type: "board",
        phase: state.phase,
        others,
        // Own identity only once it's public (results) or solved.
        mine:
          state.phase === "results" || state.phase === "ended" || solvedOrder.includes(pid)
            ? (identities.get(pid) ?? null)
            : null,
        writeFor: custom ? (writeFor.get(pid) ?? null) : null,
        writeForNick: custom ? nickOf(writeFor.get(pid) ?? null) : null,
        written: custom ? (written.get(pid) ?? drafts.get(pid) ?? "") : "",
        submitted: custom ? written.has(pid) : false,
      });
    }
  }

  function computePlacements(): { placements: Record<string, number>; winnerId: string | null } {
    const out: Record<string, number> = {};
    solvedOrder.forEach((pid, i) => {
      out[pid] = i + 1;
    });
    const lastRank = solvedOrder.length + 1;
    for (const p of players) {
      if (!(p.playerId in out)) out[p.playerId] = lastRank;
    }
    return { placements: out, winnerId: solvedOrder[0] ?? null };
  }

  function endWith(prefix: string) {
    if (state.ended) return;
    state.ended = true;
    state.phase = "ended";
    const { placements, winnerId } = computePlacements();
    const summary = winnerId
      ? `${prefix}${nickOf(winnerId)} guessed first · ${solvedOrder.length}/${n} solved`
      : `${prefix}nobody guessed their identity`;
    broadcastState(true);
    sendBoards(true);
    ctx.endMatch({ winnerId, placements, summary });
  }

  function connectedCount(): number {
    let c = 0;
    for (const pid of connected) if (participantIds.has(pid)) c++;
    return c;
  }

  function allWritten(): boolean {
    for (const pid of connected) if (!written.has(pid)) return false;
    return true;
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
        sendBoards();
        return;
      }
      if (connectedCount() < 2) {
        endWith("not enough players · ");
        return;
      }
      if (now >= state.phaseEndsAt) {
        if (state.phase === "write") enterPlay(now);
        else if (state.phase === "play") enterResults(now);
        else if (state.phase === "results") {
          endWith("");
          return;
        }
      }
      broadcastState();
      sendBoards();
    },

    onMessage(playerId, msg) {
      if (state.ended) return;
      const now = Date.now();
      // No warm-up gate: typing during the 3-2-1 is harmless.
      if (!participantIds.has(playerId) || !connected.has(playerId)) return;

      if (state.phase === "write" && custom) {
        if (msg.type !== "identity") return;
        if (typeof msg.text !== "string") return;
        const text = msg.text.trim().slice(0, MAX_IDENTITY_LEN);
        if (msg.final === true) {
          written.set(playerId, text);
          if (allWritten()) state.phaseEndsAt = Math.max(now, ctx.startAt);
        } else if (!written.has(playerId)) {
          // Draft — kept in case the phase ends mid-typing; doesn't count
          // as "in" for the early finish.
          drafts.set(playerId, text);
        }
        state.dirty = true;
        state.boardDirty = true;
        return;
      }

      if (state.phase === "play") {
        if (now < ctx.startAt) return; // nobody has asked anything yet
        if (msg.type === "solved" || msg.type === "unsolve") {
          const target = msg.playerId;
          if (typeof target !== "string" || !participantIds.has(target)) return;
          if (target === playerId) return; // the room confirms, not you
          const idx = solvedOrder.indexOf(target);
          if (msg.type === "solved" && idx === -1) solvedOrder.push(target);
          else if (msg.type === "unsolve" && idx !== -1) solvedOrder.splice(idx, 1);
          else return;
          state.boardDirty = true;
          ensureTurnValid();
          recomputePlayEnd(now);
        } else if (msg.type === "next-turn") {
          if (playerId !== turnId) return; // only the active player passes
          passTurn(playerId);
        }
      }
    },

    onPlayerLeft(playerId) {
      if (state.ended) return;
      if (!connected.has(playerId)) return;
      connected.delete(playerId);
      state.dirty = true;
      const now = Date.now();
      if (now < ctx.startAt) return;
      if (state.phase === "write" && allWritten()) state.phaseEndsAt = now;
      if (state.phase === "play") {
        ensureTurnValid();
        recomputePlayEnd(now);
      }
    },

    cleanup() {},
  };
}

function makeDefinition(custom: boolean): MiniGameDefinition {
  return {
    id: custom ? "who-am-i-custom" : "who-am-i",
    displayName: custom ? "Who Am I? (custom)" : "Who Am I?",
    gamemode: "last-man-standing",
    matchSize: 16,
    minPlayers: 2,
    maxPlayers: 16,
    orientation: "portrait",
    tickHz: 10,
    matchTimeoutMs:
      (custom ? WRITE_MS : 0) + PLAY_MS + RESULTS_MS + 12_000,
    shuffleWeight: custom ? 1 : 2,
    createMatch: (ctx) => createWhoAmIMatch(custom, ctx),
  };
}

registerMiniGame(makeDefinition(false));
registerMiniGame(makeDefinition(true));
