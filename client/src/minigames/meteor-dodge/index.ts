// Meteor Dodge match client. Kaplay scene rendering the canonical server
// state: all players' avatars on the ground line, meteors (circles with a
// thin streak rect above each) raining from the top. Self-avatar renders at
// full opacity on top; others are ghosted behind.
//
// Drag anywhere — your avatar walks toward the touch x.

import kaplay from "kaplay";
import type {
  AnchorComp,
  ColorComp,
  GameObj,
  OpacityComp,
  PosComp,
  RectComp,
  SpriteComp,
} from "kaplay";
import { steelData } from "@kaplayjs/crew";
import { avatarSrc } from "../../identity";
import { createMatchFlash } from "../flash";
import { formatRemaining, statusLine } from "../clock";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  player: { radius: number; groundY: number };
  players: { playerId: string; nickname: string; avatarId: string }[];
  deadlineAt: number;
};

type StateMsg = {
  type: "state";
  players: Record<string, { x: number; y: number; alive: boolean }>;
  meteors: { id: number; x: number; y: number; r: number }[];
  deadlineAt: number;
};

type AvatarSprite = GameObj<PosComp | SpriteComp | AnchorComp | OpacityComp>;
type MeteorBody = GameObj<PosComp | SpriteComp | ColorComp | AnchorComp>;
type MeteorStreak = GameObj<
  PosComp | RectComp | ColorComp | AnchorComp | OpacityComp
>;
type MarkerSprite = GameObj<PosComp | ColorComp>;

const GHOST_OPACITY = 0.4;
const SEND_THROTTLE_MS = 33;
const MOVE_MIN_X = 16;
const MOVE_MAX_X = 484;

function createMeteorDodgeMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .md {
        flex: 1; display: flex; flex-direction: column;
        min-height: 0; background: #0a0a14;
        position: relative; /* anchors the .match-flash overlay */
      }
      .md-stage { flex: 1; position: relative; overflow: hidden; }
      .md-stage canvas { display: block; }
      .md-status {
        padding: 6px 0 8px; text-align: center; color: #9a9aa5;
        font-size: 12px; flex: none; user-select: none;
      }
      .md-status.md-dead { color: #f2f2f5; animation: md-dead-flash 0.6s ease; }
      @keyframes md-dead-flash {
        0% { background: #6e2233; }
        100% { background: transparent; }
      }
    </style>
    <div class="md">
      <div class="md-stage" id="md-stage"></div>
      <div class="md-status" id="md-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#md-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#md-status")!;
  const flash = createMatchFlash(ctx.container.querySelector<HTMLElement>(".md")!);

  let fieldW = 500;
  let fieldH = 800;
  let playerRadius = 16;
  let groundY = 760;

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  const avatarSprites = new Map<string, AvatarSprite>();
  const meteorSprites = new Map<
    number,
    { body: MeteorBody; streak: MeteorStreak }
  >();
  let players: WelcomeMsg["players"] = [];
  // Previous alive-state per player, for elimination flashes.
  const wasAlive = new Map<string, boolean>();
  // "YOU" marker above the own avatar for the first seconds — kaplay text()
  // renders as a glyph-less black bar, so it's drawn geometry instead.
  let youMarker: MarkerSprite | null = null;
  let youMarkerUntil = 0;
  /** Sprites are loaded (meteor bodies reference the steel sprite, which is
   *  created lazily in applyState and must not race the async load). */
  let spritesReady = false;

  // Drag input — target x, sent throttled from onUpdate.
  let desiredX: number | null = null;
  let lastSentAt = 0;
  let lastSentX: number | null = null;

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    playerRadius = welcome.player.radius;
    groundY = welcome.player.groundY;
    players = welcome.players;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [14, 14, 26],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    // Ground strip under the avatars' feet.
    kk.add([
      kk.rect(fieldW, fieldH - (groundY + playerRadius)),
      kk.pos(0, groundY + playerRadius),
      kk.anchor("topleft"),
      kk.color(46, 40, 54),
    ]);

    for (const p of players) {
      kk.loadSprite(`md-${p.playerId}`, avatarSrc(p.avatarId));
    }
    // Meteors use the crew "steel" ball sprite (tinted orange every other id)
    // — plain colored circles looked out of place next to the crew avatars.
    kk.loadSprite(
      "md-meteor",
      steelData.kind === "Sprite" ? steelData.outlined : "",
    );

    // Render order: ghosts first (drawn behind), self last (drawn in front).
    const ordered = [...players];
    const selfIdx = ordered.findIndex((p) => p.playerId === ctx.selfPlayerId);
    if (selfIdx >= 0) {
      const self = ordered.splice(selfIdx, 1)[0];
      ordered.push(self);
    }

    kk.onLoad(() => {
      spritesReady = true;
      for (const p of ordered) {
        const isSelf = p.playerId === ctx.selfPlayerId;
        const avatar = kk.add([
          kk.sprite(`md-${p.playerId}`, {
            width: playerRadius * 2.4,
            height: playerRadius * 2.4,
          }),
          kk.pos(fieldW / 2, groundY),
          kk.anchor("center"),
          kk.opacity(isSelf ? 1 : GHOST_OPACITY),
        ]);
        avatarSprites.set(p.playerId, avatar);
      }
    });

    if (!ctx.isSpectator) {
      // Down-pointing triangle marker (no kaplay text — see note above).
      youMarker = kk.add([
        kk.polygon([kk.vec2(-10, -12), kk.vec2(10, -12), kk.vec2(0, 0)]),
        kk.pos(-99, -99),
        kk.color(171, 221, 100),
        kk.outline(2, kk.rgb(255, 255, 255)),
      ]) as unknown as MarkerSprite;

      // Drag anywhere — walk toward the touch x. Positions from kaplay's own
      // handlers are already letterbox-mapped game coords.
      const clampX = (x: number) =>
        Math.max(MOVE_MIN_X, Math.min(MOVE_MAX_X, x));
      const onDrag = (pos: { x: number; y: number }) => {
        desiredX = clampX(pos.x);
      };
      kk.onTouchStart(onDrag);
      kk.onTouchMove(onDrag);
      kk.onMousePress(() => onDrag(kk.mousePos()));
      kk.onMouseMove(() => {
        if (kk.isMouseDown()) onDrag(kk.mousePos());
      });

      kk.onUpdate(() => {
        const now = Date.now();
        if (desiredX === null) return;
        if (now - lastSentAt < SEND_THROTTLE_MS) return;
        if (desiredX === lastSentX) return;
        ctx.send({ type: "move", x: desiredX });
        lastSentX = desiredX;
        lastSentAt = now;
      });
    }
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = "";
    youMarkerUntil = Date.now() + 7_000;
    buildScene(msg);
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    const kk = k;

    // Avatars.
    for (const [pid, data] of Object.entries(msg.players)) {
      const sprite = avatarSprites.get(pid);
      const isSelf = pid === ctx.selfPlayerId;
      if (sprite) {
        sprite.pos.x = data.x;
        sprite.pos.y = data.y;
        const baseOpacity = isSelf ? 1 : GHOST_OPACITY;
        sprite.opacity = data.alive ? baseOpacity : baseOpacity * 0.25;
      }
      // Elimination cue.
      const prev = wasAlive.get(pid);
      if (prev === true && !data.alive) {
        if (isSelf) {
          flash.flash("☄️ you got hit");
          statusEl.classList.remove("md-dead");
          void statusEl.offsetWidth; // restart animation
          statusEl.classList.add("md-dead");
        } else {
          const nick = players.find((p) => p.playerId === pid)?.nickname ?? "?";
          flash.flash(`☄️ ${nick} down`);
        }
      }
      wasAlive.set(pid, data.alive);
    }

    // Meteors — sync body+streak pairs to current state (same objects
    // updated frame to frame; grey/orange alternating by id).
    const seen = new Set<number>();
    for (const m of msg.meteors) {
      seen.add(m.id);
      let pair = meteorSprites.get(m.id);
      if (!pair) {
        if (!spritesReady) continue; // steel sprite still loading
        const orange = m.id % 2 === 1;
        const streak = kk.add([
          kk.rect(4, 26),
          kk.pos(m.x, m.y - m.r - 2),
          kk.anchor("bot"),
          kk.color(150, 150, 165),
          kk.opacity(0.6),
        ]);
        const body = kk.add([
          kk.sprite("md-meteor", { width: m.r * 2, height: m.r * 2 }),
          kk.pos(m.x, m.y),
          kk.anchor("center"),
          // Sprite tint (multiplies) — orange glow vs plain steel.
          orange ? kk.color(255, 180, 110) : kk.color(255, 255, 255),
        ]);
        pair = { body, streak };
        meteorSprites.set(m.id, pair);
      } else {
        pair.body.pos.x = m.x;
        pair.body.pos.y = m.y;
        pair.streak.pos.x = m.x;
        pair.streak.pos.y = m.y - m.r - 2;
      }
    }
    for (const [id, pair] of meteorSprites) {
      if (seen.has(id)) continue;
      try {
        pair.body.destroy();
        pair.streak.destroy();
      } catch {
        /* ignore */
      }
      meteorSprites.delete(id);
    }

    // Match score + status line: alive count and clock.
    const total = Object.keys(msg.players).length;
    const alive = Object.values(msg.players).filter((p) => p.alive).length;
    ctx.setMatchScore(`${alive}/${total} alive`);

    const mine = msg.players[ctx.selfPlayerId];
    const clock = formatRemaining(msg.deadlineAt);
    statusEl.textContent = !mine
      ? statusLine("spectating", `${alive}/${total} alive`, clock)
      : statusLine(
          mine.alive ? null : "you got hit",
          `${alive}/${total} alive`,
          clock,
        );

    // Float the "YOU" tag above the own avatar while it's active.
    if (youMarker) {
      if (!mine || !mine.alive || Date.now() > youMarkerUntil) {
        youMarker.hidden = true;
      } else {
        youMarker.hidden = false;
        youMarker.pos.x = mine.x;
        youMarker.pos.y = mine.y - playerRadius * 1.4 - 4;
      }
    }
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      flash.destroy();
      try {
        k?.quit();
      } catch {
        /* ignore */
      }
      k = null;
      avatarSprites.clear();
      meteorSprites.clear();
      wasAlive.clear();
      youMarker = null;
      ctx.container.innerHTML = "";
    },
  };
}

const MeteorDodgeClient: MiniGameClientDefinition = {
  id: "meteor-dodge",
  controlsHint: "drag left / right — dodge the falling meteors",
  createMatch: createMeteorDodgeMatchClient,
};

registerMiniGameClient(MeteorDodgeClient);

export default MeteorDodgeClient;
