// Copter Cave match client. Kaplay scene rendering the canonical server
// state: a scrolling rock tunnel (two rects per cave segment) and every
// player's copter in the same fixed X column. Self-copter renders at full
// opacity on top; others are ghosted behind.
//
// HOLD anywhere to rise, release to fall.

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
  copter: { x: number; radius: number };
  segWidth: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
  deadlineAt: number;
};

type StateMsg = {
  type: "state";
  copters: Record<string, { y: number; vy: number; alive: boolean }>;
  segments: { id: number; x: number; gapY: number; gapH: number }[];
  deadlineAt: number;
};

type CopterSprite = GameObj<PosComp | SpriteComp | AnchorComp | OpacityComp>;
type RockSprite = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;
type MarkerSprite = GameObj<PosComp | ColorComp>;

const GHOST_OPACITY = 0.4;

function createCopterCaveMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .cc {
        flex: 1; display: flex; flex-direction: column;
        min-height: 0; background: #0a0a14;
        position: relative; /* anchors the .match-flash overlay */
      }
      .cc-stage { flex: 1; position: relative; overflow: hidden; }
      .cc-stage canvas { display: block; }
      .cc-status {
        padding: 6px 0 8px; text-align: center; color: #9a9aa5;
        font-size: 12px; flex: none; user-select: none;
      }
      .cc-status.cc-dead { color: #f2f2f5; animation: cc-dead-flash 0.6s ease; }
      @keyframes cc-dead-flash {
        0% { background: #6e2233; }
        100% { background: transparent; }
      }
    </style>
    <div class="cc">
      <div class="cc-stage" id="cc-stage"></div>
      <div class="cc-status" id="cc-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#cc-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#cc-status")!;
  const flash = createMatchFlash(ctx.container.querySelector<HTMLElement>(".cc")!);

  let fieldW = 500;
  let fieldH = 800;
  let copterX = 140;
  let copterRadius = 14;
  let segWidth = 60;

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  const copterSprites = new Map<string, CopterSprite>();
  const segSprites = new Map<number, { top: RockSprite; bottom: RockSprite }>();
  let players: WelcomeMsg["players"] = [];
  // Previous alive-state per player, for elimination flashes.
  const wasAlive = new Map<string, boolean>();
  // "YOU" marker above the own copter for the first seconds — kaplay text()
  // renders as a glyph-less black bar, so it's drawn geometry instead.
  let youMarker: MarkerSprite | null = null;
  let youMarkerUntil = 0;
  let holding = false;

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    copterX = welcome.copter.x;
    copterRadius = welcome.copter.radius;
    segWidth = welcome.segWidth;
    players = welcome.players;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [18, 22, 36],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    for (const p of players) {
      kk.loadSprite(`cc-${p.playerId}`, avatarSrc(p.avatarId));
    }

    // Render order: ghosts first (drawn behind), self last (drawn in front).
    const ordered = [...players];
    const selfIdx = ordered.findIndex((p) => p.playerId === ctx.selfPlayerId);
    if (selfIdx >= 0) {
      const self = ordered.splice(selfIdx, 1)[0];
      ordered.push(self);
    }

    kk.onLoad(() => {
      for (const p of ordered) {
        const isSelf = p.playerId === ctx.selfPlayerId;
        const copter = kk.add([
          kk.sprite(`cc-${p.playerId}`, {
            width: copterRadius * 2.4,
            height: copterRadius * 2.4,
          }),
          kk.pos(copterX, fieldH / 2),
          kk.anchor("center"),
          kk.opacity(isSelf ? 1 : GHOST_OPACITY),
        ]);
        copterSprites.set(p.playerId, copter);
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

      // Hold to rise, release to fall. Send only on state change.
      const setHold = (on: boolean) => {
        if (holding === on) return;
        holding = on;
        ctx.send({ type: "hold", on });
      };
      kk.onTouchStart(() => setHold(true));
      kk.onTouchEnd(() => setHold(false));
      kk.onMousePress(() => setHold(true));
      kk.onMouseRelease(() => setHold(false));
    }
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = "hold to rise · release to fall";
    youMarkerUntil = Date.now() + 7_000;
    buildScene(msg);
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    const kk = k;

    // Copters.
    for (const [pid, data] of Object.entries(msg.copters)) {
      const sprite = copterSprites.get(pid);
      const isSelf = pid === ctx.selfPlayerId;
      if (sprite) {
        sprite.pos.y = data.y;
        const baseOpacity = isSelf ? 1 : GHOST_OPACITY;
        sprite.opacity = data.alive ? baseOpacity : baseOpacity * 0.25;
      }
      // Elimination cue.
      const prev = wasAlive.get(pid);
      if (prev === true && !data.alive) {
        if (isSelf) {
          flash.flash("💥 you crashed");
          statusEl.classList.remove("cc-dead");
          void statusEl.offsetWidth; // restart animation
          statusEl.classList.add("cc-dead");
        } else {
          const nick = players.find((p) => p.playerId === pid)?.nickname ?? "?";
          flash.flash(`💥 ${nick} down`);
        }
      }
      wasAlive.set(pid, data.alive);
    }

    // Cave segments — sync rock sprite pairs to current state. Width +1 to
    // hide sub-pixel seams between neighbours.
    const seen = new Set<number>();
    for (const s of msg.segments) {
      seen.add(s.id);
      const gapTop = s.gapY - s.gapH / 2;
      const gapBottom = s.gapY + s.gapH / 2;
      let pair = segSprites.get(s.id);
      if (!pair) {
        const top = kk.add([
          kk.rect(segWidth + 1, fieldH),
          kk.pos(s.x, gapTop),
          kk.anchor("botleft"),
          kk.color(58, 48, 66),
        ]);
        const bottom = kk.add([
          kk.rect(segWidth + 1, fieldH),
          kk.pos(s.x, gapBottom),
          kk.anchor("topleft"),
          kk.color(58, 48, 66),
        ]);
        pair = { top, bottom };
        segSprites.set(s.id, pair);
      } else {
        pair.top.pos.x = s.x;
        pair.top.pos.y = gapTop;
        pair.bottom.pos.x = s.x;
        pair.bottom.pos.y = gapBottom;
      }
    }
    for (const [id, pair] of segSprites) {
      if (seen.has(id)) continue;
      try {
        pair.top.destroy();
        pair.bottom.destroy();
      } catch {
        /* ignore */
      }
      segSprites.delete(id);
    }

    // Match score + status line: alive count and clock.
    const total = Object.keys(msg.copters).length;
    const alive = Object.values(msg.copters).filter((c) => c.alive).length;
    ctx.setMatchScore(`${alive}/${total} alive`);

    const mine = msg.copters[ctx.selfPlayerId];
    const clock = formatRemaining(msg.deadlineAt);
    statusEl.textContent = !mine
      ? statusLine("spectating", `${alive}/${total} alive`, clock)
      : statusLine(
          mine.alive ? null : "you crashed · keep watching",
          `${alive}/${total} alive`,
          clock,
        );

    // Float the "YOU" tag above the own copter while it's active.
    if (youMarker) {
      if (!mine || !mine.alive || Date.now() > youMarkerUntil) {
        youMarker.hidden = true;
      } else {
        youMarker.hidden = false;
        youMarker.pos.x = copterX;
        youMarker.pos.y = Math.max(20, mine.y - copterRadius * 1.4 - 4);
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
      copterSprites.clear();
      segSprites.clear();
      wasAlive.clear();
      youMarker = null;
      ctx.container.innerHTML = "";
    },
  };
}

const CopterCaveClient: MiniGameClientDefinition = {
  id: "copter-cave",
  controlsHint: "hold to rise, let go to fall — stay inside the cave",
  createMatch: createCopterCaveMatchClient,
};

registerMiniGameClient(CopterCaveClient);

export default CopterCaveClient;
