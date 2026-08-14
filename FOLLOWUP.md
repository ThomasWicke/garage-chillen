# Follow-up notes

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

## Testing workflow ideas (shelved by request — unchanged)

The pain: localStorage holds ONE identity per browser profile, so multiplayer
testing means N incognito windows. Ideas, roughly in order of value/effort:

1. **Headless bot script**: a Node script using `partysocket` that spawns N
   fake players into a lobby code — `npm run bots -- ABCD 4`. Protocol is
   fully typed in `party/protocol.ts`; identity is just a UUID + `identify`.
   Bots answer per-game with naive inputs. You play on one real device.
2. **Identity override via URL param** (`?pid=bot1&nick=Bot1`) bypassing
   localStorage — makes N plain tabs viable and enables idea 3.
3. **Multi-client harness page**: dev-only `/test` route with 4–6 iframes,
   each with a `?pid=` identity — a whole lobby in one window.
4. **Server test mode**: TEST-prefixed rooms get near-zero countdowns, a
   debug force-start message, optionally server-side bots.
5. **Deterministic sim tests**: inject a clock via `MatchContext`
   (`ctx.now()`) so vitest can step ticks and unit-test collision/placement
   logic — several round-1 placement bugs would have been caught by tests.
6. **Playwright multi-context e2e** as a later smoke suite.

Recommended starting combo: 1 + 2, then 4.

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
