// Tower Stack match client. Kaplay scene (rects only — no kaplay text) that
// renders YOUR OWN tower full-screen: placed blocks hue-shift per level, the
// sliding block is animated locally from the server's oscillation params
// {centerX, amplitude, speed, anchorT} so motion is buttery while the server
// stays authoritative on the drop position. A DOM sidebar lists every
// player's current height so all the parallel towers feel live. Tap
// anywhere to drop. After you top out (or as a spectator) the view switches
// to the current leader's tower.

import kaplay from "kaplay";
import type { ColorComp, GameObj, PosComp, RectComp } from "kaplay";
import { avatarSrc } from "../../identity";
import { formatRemaining, statusLine } from "../clock";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Osc = { centerX: number; amplitude: number; speed: number; anchorT: number };

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  blockH: number;
  startWidth: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
  deadlineAt: number;
};

type PlayerState = {
  level: number;
  done: boolean;
  left: boolean;
  width: number;
  osc: Osc;
  /** Level index of the first entry in `blocks` (towers are wire-capped). */
  from: number;
  /** [centerX, width] per block, bottom-up from `from`. */
  blocks: [number, number][];
};

type StateMsg = {
  type: "state";
  players: Record<string, PlayerState>;
  deadlineAt: number;
};

type BlockRect = GameObj<PosComp | RectComp | ColorComp>;

/** Keep the sliding block at or below this y — the camera shifts the tower
 *  down once it grows past here. */
const SLIDER_MIN_Y = 170;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function hueColor(level: number): [number, number, number] {
  return hslToRgb((level * 22) % 360, 0.7, 0.55);
}

/** Same ping-pong formula as the server. */
function oscXAt(osc: Osc, t: number): number {
  if (osc.amplitude <= 0) return osc.centerX;
  const elapsed = Math.max(0, t - osc.anchorT) / 1000;
  const range = 2 * osc.amplitude;
  const p = (elapsed * osc.speed) % (2 * range);
  const offset = p <= range ? p : 2 * range - p;
  return osc.centerX - osc.amplitude + offset;
}

function createTowerStackMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="twr">
      <style>
        .twr { position: relative; width: 100%; height: 100%; background: #0a0a14; }
        .twr-stage { position: absolute; inset: 0; }
        .twr-side {
          position: absolute; top: 8px; right: 8px; z-index: 5;
          background: rgba(10, 10, 20, 0.72); border: 1px solid #2a2a3a;
          border-radius: 10px; padding: 6px 8px; max-height: 46%;
          overflow: hidden; font-size: 12px; color: #f2f2f5;
          pointer-events: none; min-width: 108px;
        }
        .twr-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
        .twr-row img { width: 18px; height: 18px; border-radius: 50%; }
        .twr-row .twr-nick {
          flex: 1; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; max-width: 96px; color: #9a9aa5;
        }
        .twr-row.twr-self .twr-nick { color: #abdd64; font-weight: 700; }
        .twr-row.twr-done { opacity: 0.45; }
        .twr-row .twr-lvl { font-weight: 700; font-variant-numeric: tabular-nums; }
        .twr-status {
          position: absolute; left: 0; right: 0; bottom: 6px; z-index: 5;
          text-align: center; font-size: 13px; color: #9a9aa5;
          pointer-events: none;
        }
        .twr-overlay {
          position: absolute; left: 50%; top: 12%; transform: translateX(-50%);
          z-index: 6; background: rgba(10, 10, 20, 0.82);
          border: 1px solid #2a2a3a; border-radius: 12px;
          color: #f2f2f5; font-size: 14px; padding: 8px 14px;
          white-space: nowrap; pointer-events: none;
        }
        .twr-flash {
          position: absolute; inset: 0; z-index: 7; pointer-events: none;
          background: #d33; opacity: 0;
        }
        .twr-flash.twr-boom { animation: twr-boom 0.6s ease-out; }
        @keyframes twr-boom {
          0% { opacity: 0.55; }
          100% { opacity: 0; }
        }
      </style>
      <div class="twr-stage" id="twr-stage"></div>
      <div class="twr-side" id="twr-side"></div>
      <div class="twr-overlay" id="twr-overlay" hidden></div>
      <div class="twr-flash" id="twr-flash"></div>
      <div class="twr-status" id="twr-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#twr-stage")!;
  const sideEl = ctx.container.querySelector<HTMLElement>("#twr-side")!;
  const overlayEl = ctx.container.querySelector<HTMLElement>("#twr-overlay")!;
  const flashEl = ctx.container.querySelector<HTMLElement>("#twr-flash")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#twr-status")!;

  let fieldW = 500;
  let fieldH = 800;
  let blockH = 34;
  let startWidth = 200;
  let players: WelcomeMsg["players"] = [];
  const nickByPid = new Map<string, string>();

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  let foundation: BlockRect | null = null;
  let slider: BlockRect | null = null;
  const blockPool: BlockRect[] = [];
  const fades: { obj: BlockRect; opacityCarrier: { opacity: number } }[] = [];

  let latest: StateMsg | null = null;
  let viewedPid: string | null = null;
  let lastViewedLevel = -1;
  let selfWasDone = false;
  let camOffset = 0;
  const sideRowByPid = new Map<string, HTMLElement>();
  let lastSideOrderKey = "";

  /** Top y of the block at `levelIdx` (0-based placed index). The implicit
   *  foundation occupies [fieldH - blockH, fieldH]; block 0 sits on it. The
   *  SLIDER for a tower with L placed blocks uses topYOfLevel(L) — one row
   *  above the current top block. */
  function topYOfLevel(levelIdx: number): number {
    return fieldH - blockH * (levelIdx + 2);
  }

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    fieldW = welcome.field.w;
    fieldH = welcome.field.h;
    blockH = welcome.blockH;
    startWidth = welcome.startWidth;
    players = welcome.players;
    nickByPid.clear();
    for (const p of players) nickByPid.set(p.playerId, p.nickname);
    buildSidebar();

    k = kaplay({
      width: fieldW,
      height: fieldH,
      background: [10, 10, 20],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    foundation = kk.add([
      kk.rect(startWidth, blockH),
      kk.pos(fieldW / 2 - startWidth / 2, fieldH - blockH),
      kk.color(70, 70, 90),
    ]);

    slider = kk.add([
      kk.rect(startWidth, blockH),
      kk.pos(-999, -999),
      kk.color(242, 242, 245),
      kk.outline(2, kk.rgb(10, 10, 20)),
    ]) as unknown as BlockRect;

    // Smooth local animation: slider position + camera easing every frame.
    kk.onUpdate(() => {
      const st = latest;
      const view = viewedPid ? st?.players[viewedPid] : null;
      if (!st || !view || !slider || !foundation) return;

      const sliderTop = topYOfLevel(view.level);
      const targetOffset = Math.max(0, SLIDER_MIN_Y - sliderTop);
      camOffset += (targetOffset - camOffset) * Math.min(1, kk.dt() * 8);

      foundation.pos.y = fieldH - blockH + camOffset;

      if (view.done || view.width <= 0) {
        slider.hidden = true;
      } else {
        slider.hidden = false;
        const x = oscXAt(view.osc, Date.now());
        slider.width = Math.max(1, view.width);
        slider.pos.x = x - view.width / 2;
        slider.pos.y = sliderTop + camOffset;
      }

      // Re-place tower blocks with the eased camera offset.
      syncBlocks(view);

      // Fading placement flashes.
      for (let i = fades.length - 1; i >= 0; i--) {
        const f = fades[i];
        f.opacityCarrier.opacity -= kk.dt() * 2.4;
        if (f.opacityCarrier.opacity <= 0) {
          try {
            f.obj.destroy();
          } catch {
            /* ignore */
          }
          fades.splice(i, 1);
        } else {
          (f.obj as unknown as { opacity: number }).opacity =
            f.opacityCarrier.opacity;
        }
      }
    });

    if (!ctx.isSpectator) {
      let lastTapAt = 0;
      const drop = () => {
        const now = Date.now();
        if (now - lastTapAt < 80) return;
        lastTapAt = now;
        const me = latest?.players[ctx.selfPlayerId];
        if (me && (me.done || me.left)) return;
        ctx.send({ type: "drop" });
      };
      kk.onTouchStart(() => drop());
      kk.onMousePress(() => drop());
    }
  }

  function syncBlocks(view: PlayerState) {
    const kk = k;
    if (!kk) return;
    const need = view.blocks.length;
    while (blockPool.length < need) {
      blockPool.push(
        kk.add([
          kk.rect(10, blockH),
          kk.pos(-999, -999),
          kk.color(255, 255, 255),
        ]) as unknown as BlockRect,
      );
    }
    for (let i = 0; i < blockPool.length; i++) {
      const obj = blockPool[i];
      if (i >= need) {
        obj.hidden = true;
        continue;
      }
      const [x, w] = view.blocks[i];
      const levelIdx = view.from + i;
      const topY = topYOfLevel(levelIdx) + camOffset;
      obj.hidden = topY > fieldH || topY < -blockH;
      const [r, g, b] = hueColor(levelIdx);
      obj.color = kk.rgb(r, g, b);
      obj.width = Math.max(1, w);
      obj.pos.x = x - w / 2;
      obj.pos.y = topY;
    }
  }

  function buildSidebar() {
    sideEl.innerHTML = players
      .map(
        (p) => `<div class="twr-row${p.playerId === ctx.selfPlayerId ? " twr-self" : ""}" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <span class="twr-nick">${escapeHtml(p.nickname)}${p.playerId === ctx.selfPlayerId ? " (you)" : ""}</span>
          <span class="twr-lvl">0</span>
        </div>`,
      )
      .join("");
    sideRowByPid.clear();
    sideEl.querySelectorAll<HTMLElement>(".twr-row").forEach((el) => {
      sideRowByPid.set(el.dataset.pid!, el);
    });
  }

  function updateSidebar(msg: StateMsg) {
    const order = [...players].sort(
      (a, b) =>
        (msg.players[b.playerId]?.level ?? 0) -
        (msg.players[a.playerId]?.level ?? 0),
    );
    for (const p of order) {
      const row = sideRowByPid.get(p.playerId);
      const st = msg.players[p.playerId];
      if (!row || !st) continue;
      row.querySelector<HTMLElement>(".twr-lvl")!.textContent = String(st.level);
      row.classList.toggle("twr-done", st.done);
    }
    const key = order.map((p) => p.playerId).join(",");
    if (key !== lastSideOrderKey) {
      lastSideOrderKey = key;
      for (const p of order) {
        const row = sideRowByPid.get(p.playerId);
        if (row) sideEl.appendChild(row);
      }
    }
  }

  function pickViewedPid(msg: StateMsg): string | null {
    const me = msg.players[ctx.selfPlayerId];
    if (me && !me.done && !ctx.isSpectator) return ctx.selfPlayerId;
    const entries = Object.entries(msg.players);
    const alive = entries.filter(([, s]) => !s.done);
    const pool = alive.length > 0 ? alive : entries;
    const topLevel = Math.max(...pool.map(([, s]) => s.level));
    // Keep the current view if it's still a top-level live tower (no flicker
    // between tied leaders).
    if (
      viewedPid &&
      pool.some(([pid, s]) => pid === viewedPid && s.level === topLevel)
    ) {
      return viewedPid;
    }
    return pool.find(([, s]) => s.level === topLevel)?.[0] ?? null;
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = "tap anywhere to drop the block";
    buildScene(msg);
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    latest = msg;

    const newViewed = pickViewedPid(msg);
    if (newViewed !== viewedPid) {
      viewedPid = newViewed;
      lastViewedLevel = viewedPid ? msg.players[viewedPid].level : -1;
      camOffset = 0;
    }
    const view = viewedPid ? msg.players[viewedPid] : null;

    // Placement flash on the viewed tower.
    if (view && view.level > lastViewedLevel && lastViewedLevel >= 0) {
      const kk = k;
      const i = view.blocks.length - 1;
      if (i >= 0) {
        const [x, w] = view.blocks[i];
        const topY = topYOfLevel(view.from + i) + camOffset;
        const flash = kk.add([
          kk.rect(Math.max(1, w), blockH),
          kk.pos(x - w / 2, topY),
          kk.color(255, 255, 255),
          kk.opacity(0.9),
        ]) as unknown as BlockRect;
        fades.push({ obj: flash, opacityCarrier: { opacity: 0.9 } });
      }
    }
    if (view) lastViewedLevel = view.level;

    updateSidebar(msg);

    const me = msg.players[ctx.selfPlayerId];
    const total = Object.keys(msg.players).length;
    const doneCount = Object.values(msg.players).filter((s) => s.done).length;
    ctx.setMatchScore(me ? `${me.level} high` : `${total - doneCount} stacking`);

    // Top-out cue: red screen flash the moment your own run ends.
    if (me && me.done && !selfWasDone) {
      selfWasDone = true;
      flashEl.classList.remove("twr-boom");
      void flashEl.offsetWidth; // restart animation
      flashEl.classList.add("twr-boom");
    }

    // Overlay: shown whenever you're watching someone else's tower.
    const watchingOther = viewedPid !== ctx.selfPlayerId;
    if (watchingOther && viewedPid) {
      overlayEl.hidden = false;
      const nick = nickByPid.get(viewedPid) ?? "?";
      overlayEl.textContent =
        me && me.done
          ? `you topped out · watching leaders (${nick})`
          : `spectating · watching ${nick}`;
    } else {
      overlayEl.hidden = true;
    }

    const clock = formatRemaining(msg.deadlineAt);
    statusEl.textContent = statusLine(
      !me
        ? "spectating"
        : me.done
          ? "you topped out"
          : "tap to drop",
      clock,
    );
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
      foundation = null;
      slider = null;
      blockPool.length = 0;
      fades.length = 0;
      latest = null;
      ctx.container.innerHTML = "";
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const TowerStackClient: MiniGameClientDefinition = {
  id: "tower-stack",
  controlsHint: "tap to drop the sliding block — stack it high, don't miss!",
  createMatch: createTowerStackMatchClient,
};

registerMiniGameClient(TowerStackClient);

export default TowerStackClient;
