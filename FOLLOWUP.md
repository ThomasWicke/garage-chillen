# Follow-up notes

## Round 6 (2026-08-15, Spy Signal → Signal Imposter)

Playtest verdict: concept strong, but the spy didn't know they were the
spy, so everyone was incentivised to blurt their symbol and the 3-vs-1
was obvious. Redesigned (module id stays `spy-signal`; display name
**Signal Imposter**):

- The imposter KNOWS they're the imposter and sees NO symbol (only the
  four candidates). Crew see the signal. The room talks — hint at it
  without naming it; the imposter bluffs and tries to work it out.
- ONE round (was two). Peek 10s (was 7), discuss 60s (was 35), vote 20s,
  reveal 12s.
- Vote phase: crew tap an avatar; the imposter taps a symbol (their guess
  at the signal). The imposter shows as "voted" once they've guessed so
  the voted-badges don't out them.
- Scoring (`party/minigames/spy-signal/index.ts` constants): caught =
  imposter has STRICTLY the most votes (a tie = escaped). Crew: +2 group
  bonus if caught, +2 more for personally voting the imposter (right vote
  pays even when the group missed). Imposter: +5 if not caught, 0 if
  caught, +2 consolation for guessing the signal. So: caught & right 4,
  caught & wrong 2, escaped & right 2, escaped & wrong 0; imposter 7/5/2/0.
- Reveal fits one phone screen, no scrolling: 36px avatar line, verdict,
  ONE row of small symbols (signal outlined green, wrong guess red),
  per-player point chips, vote tally chips; the sub-line explains the
  scoring in one sentence.
- Why "picked the spy but lost" happened before: two rounds, +3 per
  correct voter vs +6 for an escaped spy — the round-1 spy who escaped
  out-scored everyone who caught the round-2 spy; plus tied votes picked
  the accused at random. Gone with one round + the new scoring.
- Also fixed in passing: the hidden reveal box rendered as an empty bordered
  card during peek/discuss (`display:flex` beat `[hidden]`), and the
  toolbar match score could wrap when the abort button is present.

## Round 5 (2026-08-15, playtest of the experimental games)

- **Don't Let Go**: fake-prompt "temptations" removed entirely (they read as
  obviously fake). The dot now accelerates without mercy instead —
  45 px/s + 2.2/s + 0.02/s² ≈ 130 at 30s, 250 at 60s, 400 at 90s.
- **Hot Bid**: audited the over-bid report — not reproducible. Bids are
  clamped to current coins at message arrival AND (now) re-clamped at
  resolve; coins only change between bidding windows; the client stepper
  clamps too. Likely sighting: the reveal shows the winning bid next to the
  ALREADY-DEBITED balance (bid 60 · balance 0), which looks like an
  over-bid.
- **Ten Seconds**: three real problems fixed. (1) The STOP button appeared
  only at GO, shoving the whole layout up mid-round. It's now visible
  (disabled, "GET READY…") through the arm phase — no more jumps.
  (2) There was no visible lead-in; the timer element now shows a big
  3…2…1 that rolls directly into 0.00. (3) The count-up compared a server
  timestamp against the raw device clock, so clock skew froze or jumped the
  display; state broadcasts now carry serverNow and the client keeps a
  smoothed clock-offset. (Server-side timing was always authoritative —
  fairness was never affected, only the display.)
- **Marble Race** (renamed from Marble Derby; id stays `marble-derby`):
  board lifted from near-black (it looked "disabled" next to the bright
  betting cards) — lighter background, brighter pegs/walls. Results now
  broadcast the FULL finish order and show a big personal line
  ("your pick: Bean → 2nd (+1)") plus the 1st–6th order.
- **Fruit Frenzy**: skull penalty −3 → −5.
- **Penalty Shootout**: regulation now plays in halves (p1 shoots rounds
  1-3, p2 shoots 4-6) instead of flip-flopping every round; sudden death
  still alternates so each extra pair gives both a shot.

## Round 4 (2026-08-14, five experimental games)

Five new games on mechanics the collection didn't have, all LMS, all in
Recommended (28 games total now):

- **Spy Signal** (minPlayers 3; redesigned as **Signal Imposter** in
  Round 6) — social deduction played IN THE ROOM: phones secretly show the
  signal symbol (imposter: none), screens go deliberately blank ("TALK!")
  while the group argues out loud, then everyone votes on their phones.
  Phones are secret-keepers + ballot boxes; the game is faces and bluffing.
  Secrets travel only over per-player sends, re-sent during the peek
  phase; broadcasts stay clean until the reveal.
- **Ten Seconds** — blind time perception: a visible timer vanishes at
  3.00s; tap STOP at exactly 10.00. Best error +3, second +1, three rounds.
- **Hot Bid** — sealed-bid auction: 100 coins, 8 prize cards (crew-sprite
  faces, values 2–10), secret bids with lock-in, highest pays what they
  bid. Points, then leftover coins as tiebreak. Bids never broadcast before
  the reveal.
- **Don't Let Go** — hold your finger on a wandering dot; 350ms grace;
  server-scheduled fake prompts ("RELEASE FOR +10!") try to trick you into
  lifting. Contact state is idempotently re-sent every 100ms (the copter
  lesson, applied from day one).
- **Marble Derby** — betting spectacle: six crew-character marbles drop
  through a server-simulated plinko board; bet before the drop (+3 winner,
  +1 second), two races. The builder simulated 300 races and fixed a real
  odds bug (open wall corridors made edge marbles win ~58%; wall pegs
  restored near-uniform odds).

All verified against the contract (no timers, no kaplay text, bounded
loops, shared-rank ties, warm-up anchoring); `tsc` + `vite build` pass.
Remember: new games need `npm run deploy:party` AND a client deploy.

## Round 3 (2026-08-14, second playtest of the new games)

- **Penalty Shootout**: shooter and keeper now look nothing alike — lime
  attack view (ball on the spot, ⚽ SHOOT buttons) vs blue keeper view
  (gloves, 🧤 DIVE buttons, blue goal frame/pitch).
- **Fruit Frenzy**: entities are crew sprites now (watermelon / apple /
  pineapple / grape / mushroom; bombs are the crew skull, boom is the
  kaboom cloud). Claimed fruit fly off directionally: YOURS go LEFT,
  everyone else's go RIGHT.
- **Copter Cave**: two causes found for the instant deaths. (1) A real bug —
  hold messages were edge-triggered and the server dropped/cleared them
  during warm-up, so a finger already held at GO free-fell; holds are now
  accepted during warm-up and the client re-syncs hold state every 100ms.
  (2) Physics were brutal (900/900/420); now asymmetric 1000 rise / 550
  gravity / 300 max fall (~35% hold duty to hover, tap-friendly), wider
  gaps (360 start, 220 min), slightly slower scroll.
- **Meteor Dodge**: meteors are the crew "steel" ball sprite (orange-tinted
  every other one) instead of flat circles.
- **Balloon Pump**: 💥 pop swapped for the crew kaboom sprite (same sweep).
- **Preparing screen**: countdown number removed — it's a pure game-name
  splash now (~1s), so it reads as an intro flash, not a third wait.
- Asset rule confirmed across all games: crew sprites for game objects,
  shapes/CSS fine for geometry, emoji only as UI glyphs (⚽🧤🥔 badges).

## Round 2 (2026-08-14, after playtest feedback)

Everything from the playtest notes was addressed, plus the previously-listed
UX gaps (except the color-tap colorblind item, skipped by request), plus ten
new mini-games.

### Playtest feedback → what changed
- **Asteroids**: central bullet-absorbing "rock" (ship-sized) blocks the
  spawn-to-spawn firing lane, so spam-firing from spawn no longer beats
  moving. Also: hit radius tightened 22→16 (matched to the sprite),
  wraparound-aware hit test, role hint no longer wiped after one frame.
- **Archive tabs**: the picker now has Recommended / Archive tabs.
  **Light Cycles, Tron Arena, and Air Hockey are archived** — GM can still
  pick them from the Archive tab, but Shuffle only draws from Recommended.
  To (un)archive any game, flip `archived: true` in its server definition.
- **Sumo Push**: lunge force halved (700 → 350 px/s).
- **Air Hockey**: server-side max paddle speed (1800 px/s, 50ms window) —
  teleport-taps now glide instead of jumping, killing the teleport-block and
  infinite-swing exploits. Archived anyway per feedback.
- **Reaction Duel**: the 10-digit number after each hit was a fractional
  reaction-time float (the armed-delay was never rounded). Now whole ms.
- **Hot Potato**: 600ms pass-arm delay after receiving the potato (server
  rejects earlier passes; the button renders disarmed "…"). Spam-tapping
  where the button will appear no longer works — everyone holds real risk.
- **Memory Sequence**: the round-1 sequence no longer leaks into the 3-2-1
  countdown (showCell suppressed during warm-up), and the flash is now
  unmissable (dim 0.3 base → full-bright + thick white ring + glow, fast
  50ms transitions; cells brighten in the input phase so "your turn" reads).
- **Waiting times**: preparing countdown 3s → 1s; tournament intro 8s → 5s
  and now leads with the mini-game name (LMS intro already did). Warm-up
  stays 3s. Net: tournament ~14s → ~9s of waiting, LMS ~9s → ~7s.
- **Black bar above player** (Flappy, also snake/cycles/tron): that was the
  "▼ YOU" marker — kaplay `text()` rendering as a glyph-less black bar. All
  four games now draw a triangle marker instead. Rule of thumb going
  forward: never use kaplay `text()`; put text in DOM overlays.

### UX gaps closed
- Match clock (m:ss to deadline) in the status line of every continuous
  game (pong, air hockey, sumo, snake, cycles, tron, asteroids, flappy).
- Visual (no sound) goal/ring-out flashes in pong, air hockey, sumo via a
  shared `.match-flash` overlay (`client/src/minigames/flash.ts`).
- LMS spectator view: late joiners / non-participants now watch the live
  scene with the yellow SPECTATING chrome instead of a static text line.
- Spectators no longer get the controls hint on the warm-up overlay.
- Lobby: non-hosts see "waiting for <host> to start a game…" (and a host-
  offline countdown during GM grace); the host star is labeled; per-player
  session points show in the roster once anyone has scored; round-results
  rows show running totals (Σ); the finale shows its auto-dismiss countdown
  to non-hosts (new `dismissAt` on the session-results state).
- The 500ms lobby interval no longer rebuilds the DOM (it patches only
  `[data-count-to]` elements) — GM buttons stop eating taps, the nickname
  caret stops jumping.
- Snake turns fire on swipe-threshold during the drag, not on finger-lift.
- Hot Potato client builds its grid once and toggles classes (no more 30Hz
  innerHTML/img rebuild).
- Flappy collision is proper circle-vs-rect (no more corner deaths).

### Ten new mini-games (all in Recommended)
Tournament 1v1: **Tug of War** (rate-limited tap masher), **Penalty
Shootout** (left/center/right mind-games, picks hidden until reveal).
Last-man-standing: **Tower Stack** (timing stacker, height placements),
**Balloon Pump** (press-your-luck, 3 rounds, hidden pop thresholds),
**Fruit Frenzy** (shared falling fruit tap-race, bombs stun), **Bubble Wrap**
(pop your 54-bubble sheet fastest, swipe-popping), **Quick Math** (8 rounds,
first correct +3 / correct +1, answers hidden until reveal), **Odd One Out**
(spot the off-shade tile, shrinking delta, wrong tap locks you out),
**Copter Cave** (hold-to-rise shared cave survival), **Meteor Dodge**
(drag-to-dodge falling meteors, speed-capped movement).
All follow the audited contract: tick-driven timers only, warm-up frozen +
input-gated, deadline-graceful, same-tick deaths share placement ranks,
forfeits rank below natural deaths, validated inputs, welcome-replay
reconnect safe. `tsc` + `vite build` pass with all 23 games registered.

### Still open (unchanged from round 1)
- Reflex-game latency fairness (reaction-duel / color-tap / contested moles
  use raw server arrival time; needs tap timestamps + clock-offset sync).
- Tournament: an absent player can keep advancing by forfeit to a podium.
- Reaction Duel plays all 5 rounds even at 3-0.
- Client countdowns trust the phone clock (no server-offset estimation).
- "Create lobby" doesn't check code availability (1-in-923k collision).
- Cross-round leave-timer landmine and sync-endRound landmine in
  party/server.ts (see round-1 notes below).
- New-game polish pass pending a real playtest (10 fresh games will surely
  have feel issues — tune constants, not structures).

## Testing workflow (implemented 2026-08-15)

Solo playtesting without a friend or a second device. Everything is gated
on the lobby code: **a code starting with `TEST` is a test lobby** (join
`TEST` from a phone, or open `/lobby/TESTanything`). Normal lobbies are
untouched.

**How to test a game alone**

1. Open `/lobby/TEST` (dev or prod), you're host.
2. In the orange **test panel** tap `+ bot` 1–3×. Bots are server-side
   players (`party/bots.ts`) that appear in the roster like anyone else.
3. Pick a game (or `Shuffle`). Play. Bots **mirror your inputs**: every
   match message you send is re-injected under each bot's id ~250ms later,
   through the same gamemode/match code path a real socket message takes.
   In tournaments each bot mirrors into its *own* match
   (`GamemodeSession.matchIdFor`), so a human-vs-bot match gives you a
   shadow opponent. No per-game AI anywhere.
4. `again: <game>` restarts the last game; `✕` in the toolbar aborts a
   running round (GM, test lobbies only).

**Bot strategies** — tap a bot's `BOT · …` tag to cycle:
- `mirror` — perfect shadow. Survives inaction-=-death games (flappy,
  copter, don't-let-go…) as long as you do; in reflex games you win by
  the 250ms.
- `sloppy` — mirrors 70% of messages, 150–700ms late → falls behind, dies
  at other times → exercises staggered LMS placements; in secret-pick
  games (penalty shootout, hot bid) it produces different picks.
- `idle` — sends nothing (the "friend who's on their phone" case).
New bots alternate mirror/sloppy.

**fast waits** (default on): tournament intro/between 2s, LMS intro
1.5s, round results 3s, shuffle gap 3s, finale 6s — and **bot-vs-bot
tournament matches are coin-flipped** instead of played (two mirror bots
would only stalemate each other until the deadline). Turn it off to see
real pacing / let bot matches run.

**Multi-phone harness**: `/test.html?code=TESTB&n=3` shows N phone-sized
iframes in one window, each with its own throwaway identity
(`?pid=harness-N`). Use it to see what non-host, spectator and loser
screens look like. `?pid=x&nick=y&avatar=bean` works on any lobby URL and
is never written to localStorage.

**Known limits**
- Bots only act while a human is sending inputs — once you're dead /
  spectating, mirror bots go quiet (LMS then usually ends fast, which is
  fine). To watch bots play without you, real per-game brains would be
  needed (`MiniGameDefinition.botBrain?` would be the hook — not built).
- Mirror bots pick what you pick: penalty shootout vs a `mirror` keeper is
  always saved; use `sloppy`/`idle` there.
- Bots are room state: if the room is evicted (nobody connected for a
  while) they vanish; add them again.
- Kaplay-driven games need a *visible* tab — background tabs pause rAF,
  so kaplay input handlers don't fire (irrelevant on a phone; matters if
  you script the browser).

Not built (still ideas): deterministic sim tests with an injected clock
(`ctx.now()`) for vitest; Playwright multi-context smoke suite.

---

## Round 1 (2026-08-14, initial bug-scan) — for reference

~25 bugs fixed across all games and both gamemodes: inverted controls in
Sumo Push (wrong-player view flip) and Light Cycles (p1 turn swap); an
Infinity-angle DoS in Asteroids that froze the whole room; tournaments
auto-forfeiting reconnected players; LMS force-end awarding everyone 1st
place; Tron crowning a disconnecting survivor; pong ball tunneling; lost
swipe inputs (single-slot queues) in all grid games; undersized sprite pools
rendering invisible walls; whack-a-mole taps ignoring letterbox and scoring
for non-participants; memory-sequence flash gaps never rendering; air-hockey
paddle lagging a full RTT; flappy roster-order placement bias; session
scores accumulating across shuffle runs; mid-round refresh showing "?" for
every bracket name; stale round-results countdowns; a lobby timer leak.
