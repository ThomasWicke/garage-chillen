// Air Hockey client. p1 view is flipped vertically so each player's own
// goal is at the top of their phone and own paddle at the bottom — natural
// "you're at the bottom of the table" feel. Drag to move own paddle. Wire
// is canonical (p1 at top in canonical orientation).

import kaplay from "kaplay";
import type {
  AnchorComp,
  CircleComp,
  ColorComp,
  GameObj,
  PosComp,
} from "kaplay";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Role = "p1" | "p2" | "spectator";
type CircleSprite = GameObj<PosComp | CircleComp | ColorComp | AnchorComp>;

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  paddle: { radius: number };
  puck: { radius: number };
  goal: { halfWidth: number };
  firstTo: number;
  deadlineAt: number;
  players: {
    p1: { playerId: string; nickname: string; avatarId: string };
    p2: { playerId: string; nickname: string; avatarId: string };
  };
};

type StateMsg = {
  type: "state";
  paddles: { p1: { x: number; y: number }; p2: { x: number; y: number } };
  puck: { x: number; y: number };
  scores: { p1: number; p2: number };
};

const SEND_THROTTLE_MS = 33;

function createAirHockeyMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="hockey">
      <div class="hockey-stage" id="hockey-stage"></div>
      <div class="hockey-status" id="hockey-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#hockey-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#hockey-status")!;

  let role: Role = "spectator";
  let fieldW = 500;
  let fieldH = 800;
  let paddleR = 32;
  let puckR = 18;
  let goalHalf = 90;
  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  let p1Paddle: CircleSprite | null = null;
  let p2Paddle: CircleSprite | null = null;
  let puck: CircleSprite | null = null;

  let myPaddleX = fieldW / 2;
  let myPaddleY = fieldH / 2;
  let lastSentAt = 0;
  let lastSentX = -1;
  let lastSentY = -1;

  // p1's view flipped vertically so own paddle is at bottom.
  function flipY(y: number): number {
    return role === "p1" ? fieldH - y : y;
  }

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    paddleR = welcome.paddle.radius;
    puckR = welcome.puck.radius;
    goalHalf = welcome.goal.halfWidth;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [200, 220, 235],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });

    // Center line.
    k.add([
      k.rect(fieldW, 2),
      k.pos(0, fieldH / 2),
      k.color(120, 140, 155),
      k.anchor("left"),
    ]);
    // Center circle (decorative).
    k.add([
      k.circle(60),
      k.pos(fieldW / 2, fieldH / 2),
      k.color(180, 200, 215),
      k.anchor("center"),
    ]);

    // Goals (just darker rectangles on top/bottom edges).
    k.add([
      k.rect(goalHalf * 2, 8),
      k.pos(fieldW / 2, flipY(0)),
      k.color(40, 80, 140),
      k.anchor("center"),
    ]);
    k.add([
      k.rect(goalHalf * 2, 8),
      k.pos(fieldW / 2, flipY(fieldH)),
      k.color(140, 60, 60),
      k.anchor("center"),
    ]);

    p1Paddle = k.add([
      k.circle(paddleR),
      k.pos(fieldW / 2, flipY(fieldH * 0.2)),
      k.color(60, 100, 200),
      k.anchor("center"),
    ]);
    p2Paddle = k.add([
      k.circle(paddleR),
      k.pos(fieldW / 2, flipY(fieldH * 0.8)),
      k.color(200, 60, 60),
      k.anchor("center"),
    ]);
    puck = k.add([
      k.circle(puckR),
      k.pos(fieldW / 2, fieldH / 2),
      k.color(30, 30, 30),
      k.anchor("center"),
    ]);

    if (!ctx.isSpectator && (role === "p1" || role === "p2")) {
      // Initialize own paddle position to a sensible default in canonical
      // coords.
      myPaddleX = fieldW / 2;
      myPaddleY = role === "p1" ? fieldH * 0.2 : fieldH * 0.8;

      const onMove = (pos: { x: number; y: number }) => {
        // pos is in display coords; convert to canonical.
        const canonicalX = pos.x;
        const canonicalY = role === "p1" ? fieldH - pos.y : pos.y;
        myPaddleX = canonicalX;
        myPaddleY = canonicalY;
      };
      k.onTouchStart(onMove);
      k.onTouchMove(onMove);
      k.onMouseDown(() => {
        if (k) onMove(k.mousePos());
      });

      k.onUpdate(() => {
        const now = Date.now();
        if (now - lastSentAt > SEND_THROTTLE_MS) {
          if (myPaddleX !== lastSentX || myPaddleY !== lastSentY) {
            ctx.send({ type: "move-paddle", x: myPaddleX, y: myPaddleY });
            lastSentX = myPaddleX;
            lastSentY = myPaddleY;
            lastSentAt = now;
          }
        }
      });
    }
  }

  function applyState(msg: StateMsg) {
    if (!p1Paddle || !p2Paddle || !puck) return;
    p1Paddle.pos.x = msg.paddles.p1.x;
    p1Paddle.pos.y = flipY(msg.paddles.p1.y);
    p2Paddle.pos.x = msg.paddles.p2.x;
    p2Paddle.pos.y = flipY(msg.paddles.p2.y);
    puck.pos.x = msg.puck.x;
    puck.pos.y = flipY(msg.puck.y);

    const myScore = role === "p2" ? msg.scores.p2 : msg.scores.p1;
    const theirScore = role === "p2" ? msg.scores.p1 : msg.scores.p2;
    ctx.setMatchScore(`${myScore} – ${theirScore}`);
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    statusEl.textContent =
      role === "spectator"
        ? `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`
        : `drag to move · first to ${msg.firstTo}`;
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
      p1Paddle = null;
      p2Paddle = null;
      puck = null;
      ctx.container.innerHTML = "";
    },
  };
}

const AirHockeyClient: MiniGameClientDefinition = {
  id: "air-hockey",
  createMatch: createAirHockeyMatchClient,
};

registerMiniGameClient(AirHockeyClient);

export default AirHockeyClient;
