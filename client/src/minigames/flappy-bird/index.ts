// Flappy Bird match client. Renders the canonical server state in a Kaplay
// scene. All birds share the same fixed X column. Self-bird is rendered at
// full opacity on top; other players are slightly transparent ("ghost mode")
// behind self.
//
// Tap anywhere on the stage to flap; gravity does the rest.

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
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  bird: { x: number; radius: number };
  pipe: { width: number; gap: number };
  players: { playerId: string; nickname: string; avatarId: string }[];
  deadlineAt: number;
};

type StateMsg = {
  type: "state";
  birds: Record<string, { y: number; vy: number; alive: boolean }>;
  pipes: { id: number; x: number; gapY: number }[];
  deadlineAt: number;
};

type BirdSprite = GameObj<PosComp | SpriteComp | AnchorComp | OpacityComp>;
type PipeSprite = GameObj<PosComp | RectComp | ColorComp | AnchorComp>;

const GHOST_OPACITY = 0.4;

function createFlappyBirdMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="fb">
      <div class="fb-stage" id="fb-stage"></div>
      <div class="fb-status" id="fb-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#fb-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#fb-status")!;

  let fieldW = 500;
  let fieldH = 800;
  let birdX = 140;
  let birdRadius = 18;
  let pipeWidth = 80;
  let pipeGap = 220;

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  const birdSprites = new Map<string, BirdSprite>();
  const pipeSprites = new Map<number, { top: PipeSprite; bottom: PipeSprite }>();
  let players: WelcomeMsg["players"] = [];

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    birdX = welcome.bird.x;
    birdRadius = welcome.bird.radius;
    pipeWidth = welcome.pipe.width;
    pipeGap = welcome.pipe.gap;
    players = welcome.players;

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [110, 195, 230],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    // Cosmetic ground line.
    kk.add([
      kk.rect(fieldW, 6),
      kk.pos(0, fieldH - 3),
      kk.color(80, 60, 40),
      kk.anchor("top"),
    ]);

    // Load avatar sprites for each player.
    for (const p of players) {
      kk.loadSprite(`fb-${p.playerId}`, avatarSrc(p.avatarId));
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
        const bird = kk.add([
          kk.sprite(`fb-${p.playerId}`, {
            width: birdRadius * 2.4,
            height: birdRadius * 2.4,
          }),
          kk.pos(birdX, fieldH / 2),
          kk.anchor("center"),
          kk.opacity(isSelf ? 1 : GHOST_OPACITY),
        ]);
        birdSprites.set(p.playerId, bird);
      }
    });

    // Tap / click to flap.
    const flap = (e?: Event) => {
      if (e) {
        e.preventDefault?.();
      }
      ctx.send({ type: "flap" });
    };
    kk.onTouchStart(() => flap());
    kk.onMousePress(() => flap());
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = "tap anywhere to flap";
    buildScene(msg);
  }

  function applyState(msg: StateMsg) {
    if (!k) return;

    // Birds.
    for (const [pid, data] of Object.entries(msg.birds)) {
      const sprite = birdSprites.get(pid);
      if (!sprite) continue;
      sprite.pos.y = data.y;
      const isSelf = pid === ctx.selfPlayerId;
      const baseOpacity = isSelf ? 1 : GHOST_OPACITY;
      sprite.opacity = data.alive ? baseOpacity : baseOpacity * 0.25;
    }

    // Pipes — sync sprites to current state.
    const seen = new Set<number>();
    const kk = k;
    for (const p of msg.pipes) {
      seen.add(p.id);
      let pair = pipeSprites.get(p.id);
      if (!pair) {
        const top = kk.add([
          kk.rect(pipeWidth, fieldH),
          kk.pos(p.x, p.gapY - pipeGap / 2),
          kk.anchor("bot"),
          kk.color(60, 160, 60),
        ]);
        const bottom = kk.add([
          kk.rect(pipeWidth, fieldH),
          kk.pos(p.x, p.gapY + pipeGap / 2),
          kk.anchor("top"),
          kk.color(60, 160, 60),
        ]);
        pair = { top, bottom };
        pipeSprites.set(p.id, pair);
      } else {
        pair.top.pos.x = p.x;
        pair.top.pos.y = p.gapY - pipeGap / 2;
        pair.bottom.pos.x = p.x;
        pair.bottom.pos.y = p.gapY + pipeGap / 2;
      }
    }
    for (const [id, pair] of pipeSprites) {
      if (seen.has(id)) continue;
      try {
        pair.top.destroy();
        pair.bottom.destroy();
      } catch {
        /* ignore */
      }
      pipeSprites.delete(id);
    }

    // Match score: alive count.
    const total = Object.keys(msg.birds).length;
    const alive = Object.values(msg.birds).filter((b) => b.alive).length;
    ctx.setMatchScore(`${alive}/${total} alive`);

    const myBird = msg.birds[ctx.selfPlayerId];
    statusEl.textContent = !myBird
      ? "spectating"
      : myBird.alive
        ? ""
        : "you died · keep watching";
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
      birdSprites.clear();
      pipeSprites.clear();
      ctx.container.innerHTML = "";
    },
  };
}

const FlappyBirdClient: MiniGameClientDefinition = {
  id: "flappy-bird",
  createMatch: createFlappyBirdMatchClient,
};

registerMiniGameClient(FlappyBirdClient);

export default FlappyBirdClient;
