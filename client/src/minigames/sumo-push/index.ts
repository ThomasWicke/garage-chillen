// Sumo Push client. Renders a circular arena with two avatar-bound
// wrestlers. Drag from your wrestler in a direction; release to lunge with
// strength proportional to drag distance. p2 view is flipped vertically so
// each player's own avatar sits at the bottom of their phone.

import kaplay from "kaplay";
import type {
  AnchorComp,
  ColorComp,
  GameObj,
  PosComp,
  RectComp,
  SpriteComp,
  OpacityComp,
} from "kaplay";
import { avatarSrc } from "../../identity";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Role = "p1" | "p2" | "spectator";
type AvatarSprite = GameObj<PosComp | SpriteComp | AnchorComp | OpacityComp>;
type Arrow = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  arena: { radius: number };
  avatar: { radius: number };
  firstTo: number;
  deadlineAt: number;
  players: {
    p1: { playerId: string; nickname: string; avatarId: string };
    p2: { playerId: string; nickname: string; avatarId: string };
  };
};

type StateMsg = {
  type: "state";
  wrestlers: {
    p1: { x: number; y: number; vx: number; vy: number; invulnUntil: number };
    p2: { x: number; y: number; vx: number; vy: number; invulnUntil: number };
  };
  scores: { p1: number; p2: number };
};

function createSumoPushMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="sumo">
      <div class="sumo-stage" id="sumo-stage"></div>
      <div class="sumo-status" id="sumo-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#sumo-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#sumo-status")!;

  let role: Role = "spectator";
  let fieldW = 500;
  let fieldH = 800;
  let arenaR = 220;
  let avatarR = 32;
  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  let p1Sprite: AvatarSprite | null = null;
  let p2Sprite: AvatarSprite | null = null;
  let arrowDot: Arrow | null = null;
  let p1Info: WelcomeMsg["players"]["p1"] | null = null;
  let p2Info: WelcomeMsg["players"]["p2"] | null = null;

  // p2's view is flipped vertically so own avatar sits at bottom.
  function flipY(y: number): number {
    return role === "p2" ? fieldH - y : y;
  }

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    arenaR = welcome.arena.radius;
    avatarR = welcome.avatar.radius;
    p1Info = welcome.players.p1;
    p2Info = welcome.players.p2;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [22, 16, 12],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    // Outer mat.
    kk.add([
      kk.circle(arenaR + 8),
      kk.pos(fieldW / 2, fieldH / 2),
      kk.color(80, 60, 40),
      kk.anchor("center"),
    ]);
    // Ring surface.
    kk.add([
      kk.circle(arenaR),
      kk.pos(fieldW / 2, fieldH / 2),
      kk.outline(3, kk.rgb(140, 100, 60)),
      kk.color(170, 130, 90),
      kk.anchor("center"),
    ]);

    kk.loadSprite(`sumo-p1`, avatarSrc(p1Info.avatarId));
    kk.loadSprite(`sumo-p2`, avatarSrc(p2Info.avatarId));

    kk.onLoad(() => {
      p1Sprite = kk.add([
        kk.sprite(`sumo-p1`, { width: avatarR * 2.2, height: avatarR * 2.2 }),
        kk.pos(fieldW / 2, fieldH / 2 - 60),
        kk.anchor("center"),
        kk.opacity(1),
      ]);
      p2Sprite = kk.add([
        kk.sprite(`sumo-p2`, { width: avatarR * 2.2, height: avatarR * 2.2 }),
        kk.pos(fieldW / 2, fieldH / 2 + 60),
        kk.anchor("center"),
        kk.opacity(1),
      ]);
      arrowDot = kk.add([
        kk.rect(8, 8),
        kk.pos(-99, -99),
        kk.color(255, 240, 120),
        kk.anchor("center"),
      ]);
    });

    if (!ctx.isSpectator && (role === "p1" || role === "p2")) {
      let touchStart: { x: number; y: number } | null = null;
      kk.onTouchStart((pos) => {
        touchStart = { x: pos.x, y: pos.y };
      });
      kk.onTouchMove((pos) => {
        if (!touchStart || !arrowDot) return;
        // Show preview of lunge direction (display space).
        arrowDot.pos.x = pos.x;
        arrowDot.pos.y = pos.y;
      });
      kk.onTouchEnd((pos) => {
        if (!touchStart) return;
        const dxDisplay = pos.x - touchStart.x;
        const dyDisplay = pos.y - touchStart.y;
        if (Math.hypot(dxDisplay, dyDisplay) < 12) {
          touchStart = null;
          if (arrowDot) arrowDot.pos.x = arrowDot.pos.y = -99;
          return;
        }
        // Convert from display space (possibly flipped) to canonical.
        const dy = role === "p2" ? -dyDisplay : dyDisplay;
        const dx = dxDisplay;
        ctx.send({ type: "lunge", dx, dy });
        touchStart = null;
        if (arrowDot) arrowDot.pos.x = arrowDot.pos.y = -99;
      });
    }
  }

  function applyState(msg: StateMsg) {
    if (!p1Sprite || !p2Sprite) return;
    const now = Date.now();
    p1Sprite.pos.x = msg.wrestlers.p1.x;
    p1Sprite.pos.y = flipY(msg.wrestlers.p1.y);
    p1Sprite.opacity =
      msg.wrestlers.p1.invulnUntil > now
        ? Math.floor(now / 100) % 2 === 0
          ? 0.4
          : 1
        : 1;
    p2Sprite.pos.x = msg.wrestlers.p2.x;
    p2Sprite.pos.y = flipY(msg.wrestlers.p2.y);
    p2Sprite.opacity =
      msg.wrestlers.p2.invulnUntil > now
        ? Math.floor(now / 100) % 2 === 0
          ? 0.4
          : 1
        : 1;

    const myScore = role === "p2" ? msg.scores.p2 : msg.scores.p1;
    const theirScore = role === "p2" ? msg.scores.p1 : msg.scores.p2;
    ctx.setMatchScore(`${myScore} – ${theirScore}`);

    if (role !== "spectator") statusEl.textContent = "drag from yourself to lunge";
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    statusEl.textContent =
      role === "spectator"
        ? `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`
        : "drag from yourself to lunge";
    buildScene(msg);
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      try {
        k?.quit();
      } catch {
        /* ignore */
      }
      k = null;
      p1Sprite = null;
      p2Sprite = null;
      arrowDot = null;
      ctx.container.innerHTML = "";
    },
  };
}

const SumoPushClient: MiniGameClientDefinition = {
  id: "sumo-push",
  createMatch: createSumoPushMatchClient,
};

registerMiniGameClient(SumoPushClient);

export default SumoPushClient;
