// Asteroids 1v1 match client. Renders the canonical server state in a Kaplay
// scene (no per-role view flip — Asteroids is omnidirectional). Each ship
// uses the player's avatar sprite, with a thrust flame and a small nose
// triangle to make heading readable.
//
// This is invoked by the tournament gamemode client when the local player
// is in an active Asteroids match. Spectator state has moved up: non-
// participants see the bracket overlay instead of the asteroids scene.
//
// Touch controls:
//   • Touch + hold anywhere on the stage: ship rotates to face that point;
//     thrust engages after a short hold threshold.
//   • Lift finger: thrust disengages.
//   • DOM-overlay FIRE button (bottom-right): tap fires a bullet.

import kaplay from "kaplay";
import type {
  AnchorComp,
  ColorComp,
  GameObj,
  OpacityComp,
  PosComp,
  RectComp,
  RotateComp,
  SpriteComp,
} from "kaplay";
import { avatarSrc } from "../../identity";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Role = "p1" | "p2";

type WelcomeMsg = {
  type: "welcome";
  role: Role;
  field: { w: number; h: number };
  ship: { radius: number };
  bullet: { size: number };
  firstTo: number;
  deadlineAt: number;
  players: {
    p1: { playerId: string; nickname: string; avatarId: string };
    p2: { playerId: string; nickname: string; avatarId: string };
  };
};

type StateMsg = {
  type: "state";
  ships: {
    p1: { x: number; y: number; angle: number; thrust: boolean; invulnUntil: number };
    p2: { x: number; y: number; angle: number; thrust: boolean; invulnUntil: number };
  };
  bullets: { x: number; y: number; ownerId: string }[];
  scores: { p1: number; p2: number };
  running: boolean;
  deadlineAt: number;
};

type ShipSprite = GameObj<
  PosComp | SpriteComp | RotateComp | AnchorComp | OpacityComp
>;
type Nose = GameObj<PosComp | RectComp | ColorComp | RotateComp | AnchorComp>;
type Bullet = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;
type Flame = GameObj<
  PosComp | RectComp | ColorComp | RotateComp | AnchorComp | OpacityComp
>;

const HOLD_THRUST_MS = 140;
const SEND_THROTTLE_MS = 33;

function createAsteroidsMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="asteroids">
      <div class="ast-stage" id="ast-stage"></div>
      <button class="ast-fire" id="ast-fire" type="button">FIRE</button>
      <div class="ast-status" id="ast-status">connecting…</div>
    </div>
  `;

  const stageEl = ctx.container.querySelector<HTMLElement>("#ast-stage")!;
  const fireBtn = ctx.container.querySelector<HTMLButtonElement>("#ast-fire")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#ast-status")!;

  let role: Role | null = null;
  let fieldW = 500;
  let fieldH = 800;
  let shipRadius = 14;
  let bulletSize = 5;
  let p1Info: WelcomeMsg["players"]["p1"] | null = null;
  let p2Info: WelcomeMsg["players"]["p2"] | null = null;

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  let p1Ship: ShipSprite | null = null;
  let p2Ship: ShipSprite | null = null;
  let p1Nose: Nose | null = null;
  let p2Nose: Nose | null = null;
  let p1Flame: Flame | null = null;
  let p2Flame: Flame | null = null;
  const bulletPool: Bullet[] = [];

  let lastSentAngle = NaN;
  let lastSentAngleAt = 0;
  let touchStartPos: { x: number; y: number } | null = null;
  let thrustEngaged = false;
  let thrustTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── view flip ─────────────────────────────────────────────────────────
  // Server state is canonical: p1 spawns at the top, p2 at the bottom. To
  // put each player's own ship at the bottom of their phone we apply a 180°
  // rotation on the p1 client. p2 sees the canonical orientation.
  function flipX(x: number): number {
    return role === "p1" ? fieldW - x : x;
  }
  function flipY(y: number): number {
    return role === "p1" ? fieldH - y : y;
  }
  function toDisplayAngle(canonical: number): number {
    return role === "p1" ? canonical + Math.PI : canonical;
  }
  function toCanonicalAngle(display: number): number {
    return role === "p1" ? display + Math.PI : display;
  }

  function angleFromShipTo(target: { x: number; y: number }): number | null {
    // `target` is in display coordinates (Kaplay touch); the ship's pos is
    // also in display coords (we wrote the flipped values there). The
    // resulting angle is therefore in display space — convert to canonical
    // before sending.
    const ownShip = role === "p1" ? p1Ship : role === "p2" ? p2Ship : null;
    if (!ownShip) return null;
    const dx = target.x - ownShip.pos.x;
    const dy = target.y - ownShip.pos.y;
    if (dx === 0 && dy === 0) return null;
    const displayAngle = Math.atan2(dx, -dy);
    return toCanonicalAngle(displayAngle);
  }

  function sendAngleIfChanged(angle: number) {
    const now = Date.now();
    if (
      Number.isFinite(lastSentAngle) &&
      Math.abs(angle - lastSentAngle) < 0.01 &&
      now - lastSentAngleAt < SEND_THROTTLE_MS
    ) {
      return;
    }
    lastSentAngle = angle;
    lastSentAngleAt = now;
    ctx.send({ type: "set-target-angle", angle });
  }

  function setThrust(on: boolean) {
    if (thrustEngaged === on) return;
    thrustEngaged = on;
    ctx.send({ type: "set-thrust", on });
  }

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    shipRadius = welcome.ship.radius;
    bulletSize = welcome.bullet.size;
    p1Info = welcome.players.p1;
    p2Info = welcome.players.p2;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [6, 6, 18],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    for (let i = 0; i < 60; i++) {
      const tone = 60 + Math.floor(Math.random() * 60);
      kk.add([
        kk.rect(2, 2),
        kk.pos(Math.random() * fieldW, Math.random() * fieldH),
        kk.color(tone, tone, tone + 20),
        kk.anchor("center"),
      ]);
    }

    kk.loadSprite(`ast-p1`, avatarSrc(p1Info.avatarId));
    kk.loadSprite(`ast-p2`, avatarSrc(p2Info.avatarId));

    kk.onLoad(() => {
      p1Ship = kk.add([
        kk.sprite(`ast-p1`, { width: shipRadius * 2.2, height: shipRadius * 2.2 }),
        kk.pos(fieldW / 2, fieldH * 0.25),
        kk.anchor("center"),
        kk.rotate(0),
        kk.opacity(1),
      ]);
      p2Ship = kk.add([
        kk.sprite(`ast-p2`, { width: shipRadius * 2.2, height: shipRadius * 2.2 }),
        kk.pos(fieldW / 2, fieldH * 0.75),
        kk.anchor("center"),
        kk.rotate(0),
        kk.opacity(1),
      ]);
      p1Nose = kk.add([
        kk.rect(6, 6),
        kk.pos(fieldW / 2, fieldH * 0.25 - shipRadius),
        kk.color(171, 221, 100),
        kk.anchor("center"),
        kk.rotate(0),
      ]);
      p2Nose = kk.add([
        kk.rect(6, 6),
        kk.pos(fieldW / 2, fieldH * 0.75 - shipRadius),
        kk.color(171, 221, 100),
        kk.anchor("center"),
        kk.rotate(0),
      ]);
      p1Flame = kk.add([
        kk.rect(8, 14),
        kk.pos(fieldW / 2, fieldH * 0.25 + shipRadius),
        kk.color(255, 180, 80),
        kk.anchor("center"),
        kk.rotate(0),
        kk.opacity(0),
      ]);
      p2Flame = kk.add([
        kk.rect(8, 14),
        kk.pos(fieldW / 2, fieldH * 0.75 + shipRadius),
        kk.color(255, 180, 80),
        kk.anchor("center"),
        kk.rotate(0),
        kk.opacity(0),
      ]);
    });

    kk.onTouchStart((pos) => {
      if (role !== "p1" && role !== "p2") return;
      touchStartPos = { x: pos.x, y: pos.y };
      const angle = angleFromShipTo(pos);
      if (angle !== null) sendAngleIfChanged(angle);
      if (thrustTimer) clearTimeout(thrustTimer);
      thrustTimer = setTimeout(() => {
        thrustTimer = null;
        setThrust(true);
      }, HOLD_THRUST_MS);
    });
    kk.onTouchMove((pos) => {
      if (role !== "p1" && role !== "p2") return;
      const angle = angleFromShipTo(pos);
      if (angle !== null) sendAngleIfChanged(angle);
      if (touchStartPos && thrustTimer) {
        const dx = pos.x - touchStartPos.x;
        const dy = pos.y - touchStartPos.y;
        if (dx * dx + dy * dy > 36) {
          clearTimeout(thrustTimer);
          thrustTimer = null;
          setThrust(true);
        }
      }
    });
    kk.onTouchEnd(() => {
      if (thrustTimer) {
        clearTimeout(thrustTimer);
        thrustTimer = null;
      }
      setThrust(false);
      touchStartPos = null;
    });

    const fire = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (role !== "p1" && role !== "p2") return;
      ctx.send({ type: "fire" });
    };
    fireBtn.addEventListener("touchstart", fire, { passive: false });
    fireBtn.addEventListener("mousedown", fire);
  }

  function applyWelcome(msg: WelcomeMsg) {
    role = msg.role;
    statusEl.textContent = `playing as ${role.toUpperCase()} · first to ${msg.firstTo}`;
    buildScene(msg);
  }

  function applyState(msg: StateMsg) {
    if (!p1Ship || !p2Ship || !p1Nose || !p2Nose || !p1Flame || !p2Flame) return;
    const now = Date.now();
    placeShip(p1Ship, p1Nose, p1Flame, msg.ships.p1, now);
    placeShip(p2Ship, p2Nose, p2Flame, msg.ships.p2, now);

    while (bulletPool.length < msg.bullets.length) {
      if (!k) break;
      bulletPool.push(
        k.add([
          k.rect(bulletSize, bulletSize),
          k.pos(0, 0),
          k.color(255, 255, 255),
          k.anchor("center"),
        ]),
      );
    }
    for (let i = 0; i < bulletPool.length; i++) {
      const b = bulletPool[i];
      const data = msg.bullets[i];
      if (data) {
        b.pos.x = flipX(data.x);
        b.pos.y = flipY(data.y);
        if (data.ownerId === p1Info?.playerId) b.color.r = 171, b.color.g = 221, b.color.b = 100;
        else b.color.r = 100, b.color.g = 200, b.color.b = 255;
        b.hidden = false;
      } else {
        b.hidden = true;
      }
    }

    const myScore = role === "p2" ? msg.scores.p2 : msg.scores.p1;
    const theirScore = role === "p2" ? msg.scores.p1 : msg.scores.p2;
    ctx.setMatchScore(`${myScore} – ${theirScore}`);

    statusEl.textContent = msg.running ? "" : "round over";
  }

  function placeShip(
    ship: ShipSprite,
    nose: Nose,
    flame: Flame,
    s: { x: number; y: number; angle: number; thrust: boolean; invulnUntil: number },
    now: number,
  ) {
    // Server state is canonical; we render in display space (180°-flipped
    // for p1). Nose/flame offsets are computed in canonical space using
    // s.angle, then the resulting WORLD point is flipped to display.
    ship.pos.x = flipX(s.x);
    ship.pos.y = flipY(s.y);
    const displayAngle = toDisplayAngle(s.angle);
    const deg = (displayAngle * 180) / Math.PI;
    ship.angle = deg;
    nose.pos.x = flipX(s.x + Math.sin(s.angle) * shipRadius);
    nose.pos.y = flipY(s.y - Math.cos(s.angle) * shipRadius);
    nose.angle = deg;
    flame.pos.x = flipX(s.x - Math.sin(s.angle) * shipRadius * 0.9);
    flame.pos.y = flipY(s.y + Math.cos(s.angle) * shipRadius * 0.9);
    flame.angle = deg;
    flame.opacity = s.thrust ? 0.85 : 0;
    const invulnerable = s.invulnUntil > now;
    ship.opacity = invulnerable ? (Math.floor(now / 100) % 2 === 0 ? 0.4 : 1) : 1;
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") {
        applyWelcome(msg as unknown as WelcomeMsg);
      } else if (msg.type === "state") {
        applyState(msg as unknown as StateMsg);
      }
    },
    unmount() {
      if (thrustTimer) clearTimeout(thrustTimer);
      try {
        k?.quit();
      } catch {
        /* ignore */
      }
      k = null;
      p1Ship = p2Ship = null;
      p1Nose = p2Nose = null;
      p1Flame = p2Flame = null;
      bulletPool.length = 0;
      ctx.container.innerHTML = "";
    },
  };
}

const AsteroidsClient: MiniGameClientDefinition = {
  id: "asteroids",
  createMatch: createAsteroidsMatchClient,
};

registerMiniGameClient(AsteroidsClient);

export default AsteroidsClient;
