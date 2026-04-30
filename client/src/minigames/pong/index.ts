// Pong (portrait) match client. Renders the canonical state from the server
// in a Kaplay scene, with a per-player view flip so each participant's own
// paddle appears at the bottom of their phone — but the wire format stays
// canonical.
//
// This is invoked by the tournament gamemode client when the local player
// is in an active Pong match. Spectator state has moved up: non-participants
// see the bracket overlay instead of a Pong scene.

import kaplay from "kaplay";
import type {
  AnchorComp,
  ColorComp,
  GameObj,
  PosComp,
  RectComp,
} from "kaplay";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Sprite = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;

type Role = "p1" | "p2";

type WelcomeMsg = {
  type: "welcome";
  role: Role;
  field: { w: number; h: number };
  paddle: { w: number; h: number };
  ball: number;
  firstTo: number;
  deadlineAt: number;
  opponent?: { playerId: string; nickname: string; avatarId: string };
};

type StateMsg = {
  type: "state";
  ball: { x: number; y: number };
  paddles: { p1: number; p2: number };
  scores: { p1: number; p2: number };
  running: boolean;
  deadlineAt: number;
};

const PADDLE_Y_TOP_RATIO = 40 / 800;
const PADDLE_Y_BOTTOM_RATIO = (800 - 40) / 800;

function createPongMatchClient(ctx: MatchClientContext): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="pong">
      <div class="pong-stage" id="pong-stage"></div>
      <div class="pong-status" id="pong-status">connecting…</div>
    </div>
  `;

  const stageEl = ctx.container.querySelector<HTMLElement>("#pong-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#pong-status")!;

  let role: Role | null = null;
  let fieldW = 500;
  let fieldH = 800;
  let paddleW = 90;
  let paddleH = 14;
  let ballSize = 14;

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  let leftPaddle: Sprite | null = null;
  let rightPaddle: Sprite | null = null;
  let ball: Sprite | null = null;

  let myPaddleX = fieldW / 2;
  let lastSentX = -1;
  let lastSentAt = 0;

  function flipY(y: number): number {
    return role === "p1" ? fieldH - y : y;
  }
  function flipX(x: number): number {
    return role === "p1" ? fieldW - x : x;
  }
  const touchToCanonicalX = flipX;

  function buildScene() {
    if (k) return;
    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [10, 10, 20],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });

    const NET_SEGMENTS = 16;
    const segW = fieldW / NET_SEGMENTS;
    for (let i = 0; i < NET_SEGMENTS; i++) {
      if (i % 2 === 0) {
        k.add([
          k.rect(segW * 0.6, 2),
          k.pos(i * segW + segW * 0.2, fieldH / 2),
          k.anchor("left"),
          k.color(60, 60, 80),
        ]);
      }
    }

    leftPaddle = k.add([
      k.rect(paddleW, paddleH),
      k.pos(fieldW / 2, fieldH * PADDLE_Y_TOP_RATIO),
      k.anchor("center"),
      k.color(240, 240, 240),
    ]);
    rightPaddle = k.add([
      k.rect(paddleW, paddleH),
      k.pos(fieldW / 2, fieldH * PADDLE_Y_BOTTOM_RATIO),
      k.anchor("center"),
      k.color(240, 240, 240),
    ]);
    ball = k.add([
      k.rect(ballSize, ballSize),
      k.pos(fieldW / 2, fieldH / 2),
      k.anchor("center"),
      k.color(240, 240, 240),
    ]);

    function onTouch(pos: { x: number; y: number }) {
      if (role !== "p1" && role !== "p2") return;
      const canonicalX = touchToCanonicalX(pos.x);
      myPaddleX = Math.max(
        paddleW / 2,
        Math.min(fieldW - paddleW / 2, canonicalX),
      );
    }
    k.onTouchStart(onTouch);
    k.onTouchMove(onTouch);
    k.onMouseDown(() => {
      if (k) onTouch(k.mousePos());
    });

    k.onUpdate(() => {
      if (role !== "p1" && role !== "p2") return;
      const ownDisplayX = flipX(myPaddleX);
      const ownDisplayY = flipY(
        role === "p1" ? fieldH * PADDLE_Y_TOP_RATIO : fieldH * PADDLE_Y_BOTTOM_RATIO,
      );
      const ownPaddle = role === "p1" ? leftPaddle : rightPaddle;
      if (ownPaddle) {
        ownPaddle.pos.x = ownDisplayX;
        ownPaddle.pos.y = ownDisplayY;
      }
      const now = Date.now();
      if (myPaddleX !== lastSentX && now - lastSentAt > 33) {
        ctx.send({ type: "paddle", x: myPaddleX });
        lastSentX = myPaddleX;
        lastSentAt = now;
      }
    });
  }

  function applyState(msg: StateMsg) {
    if (!leftPaddle || !rightPaddle || !ball) return;
    const p1DisplayX = flipX(msg.paddles.p1);
    const p1DisplayY = flipY(fieldH * PADDLE_Y_TOP_RATIO);
    const p2DisplayX = flipX(msg.paddles.p2);
    const p2DisplayY = flipY(fieldH * PADDLE_Y_BOTTOM_RATIO);
    if (role !== "p1") {
      leftPaddle.pos.x = p1DisplayX;
      leftPaddle.pos.y = p1DisplayY;
    }
    if (role !== "p2") {
      rightPaddle.pos.x = p2DisplayX;
      rightPaddle.pos.y = p2DisplayY;
    }
    ball.pos.x = flipX(msg.ball.x);
    ball.pos.y = flipY(msg.ball.y);

    const myScore = role === "p2" ? msg.scores.p2 : msg.scores.p1;
    const theirScore = role === "p2" ? msg.scores.p1 : msg.scores.p2;
    ctx.setMatchScore(`${myScore} – ${theirScore}`);

    statusEl.textContent = msg.running ? "" : "round over";
  }

  function applyWelcome(msg: WelcomeMsg) {
    role = msg.role;
    fieldW = msg.field.w;
    fieldH = msg.field.h;
    paddleW = msg.paddle.w;
    paddleH = msg.paddle.h;
    ballSize = msg.ball;
    myPaddleX = fieldW / 2;
    statusEl.textContent = `playing as ${role.toUpperCase()} · first to ${msg.firstTo}`;
    buildScene();
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
      try {
        k?.quit();
      } catch {
        /* ignore */
      }
      k = null;
      leftPaddle = null;
      rightPaddle = null;
      ball = null;
      ctx.container.innerHTML = "";
    },
  };
}

const PongClient: MiniGameClientDefinition = {
  id: "pong",
  createMatch: createPongMatchClient,
};

registerMiniGameClient(PongClient);

export default PongClient;
