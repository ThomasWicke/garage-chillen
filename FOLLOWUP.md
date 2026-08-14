# Bug-scan follow-up (2026-08-14)

A full review pass ran over every mini-game (server + client), both gamemodes,
the bracket, and the lobby shell. The obvious bugs were fixed directly (see
"What was fixed" below). Everything else worth knowing is listed here, roughly
by how much it hurts.

## What was fixed in this pass

- **sumo-push**: view flip was on the wrong player — both players saw their own
  wrestler at the TOP while the hint said bottom, so opening lunges went the
  wrong way. Also: collision "snap" impulse pulled wrestlers together instead
  of apart (sticky contact), respawn invulnerability was only a delayed loss
  (now clamps you inside the ring), and desktop had no controls at all.
- **light-cycles**: p1's turn controls were fully inverted (a 180° view rotation
  preserves left/right; the client swapped anyway). Every tap turned the bike
  the opposite way.
- **snake/light-cycles/tron**: single-slot pending input dropped the first of
  two quick swipes (a tap-tap U-turn became a single turn into a wall; in snake
  both inputs could be lost). Now a 2-deep queue, one turn per step.
- **tron/light-cycles/snake clients**: trail sprite pools were smaller than the
  worst-case cell count — overflow silently dropped the *newest* cells, i.e.
  your own freshest walls went invisible. Pools now cover the full grid.
- **tron**: the last survivor disconnecting was ranked #1 ("X survives").
  Forfeits now rank below natural deaths.
- **pong**: ball speed was uncapped (5%/hit) and eventually tunneled through
  paddles → phantom goals in long rallies. Capped below the tunneling threshold.
- **asteroids**: `set-target-angle` with `Infinity`/`1e300` hung the angle-
  normalization loop and froze the whole room (any client could DoS the lobby).
  Also fixed a stale header comment.
- **air-hockey**: your own paddle was rendered from the server echo, trailing
  your finger by a full round trip. It now renders from the local position
  (same approach as pong).
- **whack-a-mole**: tap mapping did manual rect math that ignored letterbox
  scaling — edge/bottom moles were untappable on most phone aspect ratios. Now
  uses kaplay's letterbox-aware input like every other game. Also: LMS now
  gates match messages to actual participants (an outsider could previously
  score and win the round).
- **memory-sequence**: the 200ms gap between flashes was never rendered, so
  repeated cells (e.g. [2,2]) merged into one long flash — ~58% of round-1
  sequences were uncountable. Core mechanic fixed.
- **memory-sequence / color-tap**: the end-of-match `setTimeout` raced the tick
  (spurious extra round could flash) and leaked past cleanup. Now tick-driven.
- **reaction-duel**: the exact future GO time was broadcast during the "armed"
  phase — a modified client could schedule a 0ms "reaction". Masked.
- **hot-potato**: if the holder disconnected during warm-up, the replacement's
  hidden timer burned through the frozen 3s and could pop ~1s after GO.
- **flappy-bird**: same-tick deaths were ranked by lobby-join order (roster
  bias, and a shared final pipe crowned a fake "survivor"). Same-tick deaths
  now share a rank; a final double-KO is reported as a tie.
- **tournament**: one >10s disconnect silently forfeited ALL your future
  matches (the disconnected-set was never cleared on rejoin). Draw/force-ended
  matches always advanced bracket slot "a" (systematic seeding bias) — now
  random as documented.
- **last-man-standing**: a force-ended match awarded EVERY player 1st place
  (10 pts each, corrupting session standings). Match-end message ordering also
  caused a pointless remount ("connecting…" flash) on every LMS match end.
- **lobby server**: mid-round refresh/join received the "playing" state before
  the player list, so the bracket rendered all names as "?" and match scenes
  got zero participants. Round-results briefly showed the previous round's
  stale dismiss countdown. Session scores now reset when a new shuffle run
  starts (previously the finale podium accumulated every past run forever —
  pick a different reset point if you'd rather have a GM button).
- **lobby client**: leaked edit-error timer on route teardown.

`npx tsc --noEmit` and `vite build` pass.

## Known issues NOT fixed (decisions or bigger work)

### Gameplay fairness
- **Reflex games are decided by latency**: reaction-duel, color-tap and
  contested whack-a-mole moles all use raw server arrival time. A 100ms-RTT
  player loses to a 20ms player before human reaction even starts, and
  color-tap's 500ms window shrinks by your latency. Proper fix: client-side
  tap timestamps plus a per-connection clock-offset estimate (ping handshake).
- **Air-hockey tap-to-teleport**: the server accepts any paddle position jump,
  and the inferred swing velocity rewards teleporting — tap-across-the-half
  gives a max-speed shot every time. Needs a server-side max paddle speed.
- **Tournament: an absent player can keep advancing** by forfeit (both-gone
  matches advance someone) up to a podium finish. Arguably fine; flagging it.
- **Reaction-duel plays all 5 rounds even at 3-0** (up to ~28 dead seconds).

### UX gaps (all games)
- **No on-screen match clock anywhere** — every server broadcasts `deadlineAt`
  every tick and no client renders it, so "time's up · leader wins" always
  arrives with zero warning. One shared countdown widget would fix all games.
- **No goal/ring-out/death feedback moment** in pong, air-hockey, sumo — the
  ball/puck silently recenters, which reads as a glitch. A 500ms flash/pause
  cue would do a lot.
- **Color-tap is colorblind-hostile**: color is the only channel and red/green
  are both present. Add symbols or labels to the signal + buttons.
- **LMS has no spectator view**: late joiners stare at "match in progress ·
  spectating" static text for up to 3 minutes even though full match state is
  streaming to them. Tournament already has watchable spectating; LMS's client
  just never mounts the scene for non-participants.
- **Lobby polish**: the 500ms full-DOM rerender can eat GM button taps and
  makes the nickname caret jump while editing; non-GM players in an idle lobby
  get zero guidance ("waiting for the host…" is never shown, GM is only an
  unlabeled star); no cumulative scoreboard is visible between rounds (only
  your own number in the toolbar); the session finale vanishes for non-GMs
  with no countdown.
- Spectators of a match get the warm-up overlay *with controls hint* for a
  match they can't play.
- Asteroids: server hit radius (22) is visibly larger than the drawn ship
  (~15) — feels like phantom hits; the role hint is wiped after one frame; the
  hit test isn't wraparound-aware (1-tick delay at the seam).
- Flappy: circle-vs-rect collision treats the bird as a square (corner deaths).
- Snake: turns register on finger-lift; detecting the swipe threshold during
  `onTouchMove` would feel snappier at 167ms/step.
- Hot-potato client rebuilds the whole grid `innerHTML` (including `<img>`s)
  at 30Hz.

### Landmines (harmless today, will bite later)
- `party/server.ts`: if a future gamemode calls `endRound` synchronously inside
  `createSession`, the server dereferences `this.active` after it was nulled.
- All countdown/warm-up UI compares server timestamps to client `Date.now()`
  with no offset estimation — a skewed phone clock shows wrong or missing
  overlays (server stays authoritative, so gameplay is unaffected).
- A player disconnecting late in round N can fire `onPlayerLeft` into round
  N+1's session (~10s leave grace crosses rounds). Current games no-op on
  unknown ids, but new games must keep doing so.
- Snake's "YOU" marker timing breaks silently if warm-up ever exceeds 7s.
- "Create lobby" doesn't check code availability (1-in-923k collision joins a
  stranger's lobby).
- Game-picker drawer snapshots the player count at open (stale enable/disable;
  server re-validates, so worst case is a dead tap).

## Testing workflow ideas (not started — just notes)

The pain: localStorage holds ONE identity per browser profile, so multiplayer
testing means N incognito windows. Ideas, roughly in order of value/effort:

1. **Headless bot script** (biggest bang, zero app changes): a Node script
   using `partysocket` that spawns N fake players into a lobby code —
   `npm run bots -- ABCD 4`. The wire protocol is fully typed in
   `party/protocol.ts`; identity is just a UUID + `identify` message. Bots
   auto-answer per-game with naive inputs (random turns every ~500ms, random
   taps, flap on a timer, correct memory-sequence taps read straight from the
   `state` broadcasts). You play on one real phone/browser; the bots fill the
   bracket.
2. **Identity override via URL param**: `?pid=bot1&nick=Bot1` bypassing
   localStorage in `ensureIdentity()`. Instantly makes N *tabs* (not incognito
   windows) viable, and enables idea 3.
3. **Multi-client harness page**: a dev-only `/test` route rendering 4–6
   iframes of the app side by side, each with a `?pid=` identity. One browser
   window = a whole lobby, every perspective visible at once.
4. **Server test mode**: rooms with a `TEST` prefix (or `partykit dev` env
   flag) get: near-zero countdowns (prepare/intro/warm-up), a debug message to
   force-start a specific mini-game, and optionally server-side bots (fake
   registry entries + per-game AI drivers calling `session.onMessage`). This
   is the "shortcut the UI and waiting screens" path — combined with idea 1
   you're inside any chosen mini-game in ~2 seconds.
5. **Deterministic sim tests**: match sessions are already factory functions
   with injected `broadcast`/`endMatch`, but they call `Date.now()` directly.
   Injecting a clock via `MatchContext` (e.g. `ctx.now()`) would let vitest
   step ticks deterministically and unit-test collision/placement logic (this
   pass found several placement bugs a 20-line test would have caught).
6. **Playwright multi-context e2e** later: one browser, N contexts, scripted
   full rounds + screenshots per mini-game as a smoke suite.

Recommended starting combo: 1 + 2 (an evening of work), then 4 when you next
touch the server.
