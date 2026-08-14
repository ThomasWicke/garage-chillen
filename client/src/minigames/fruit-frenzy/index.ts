// Fruit Frenzy client. DOM arena: absolutely-positioned crew-sprite images
// moved via style.transform on every state broadcast. Tap a fruit to claim
// it first (+1); tap a bomb (skull) and you eat -3 plus a 1.5s stun (arena
// edges glow red while stunned). Live scoreboard of all players at the top.
//
// Pop cues come from the server's `events` array in each state message.
// Fruits YOU claimed fly off to the LEFT; fruits claimed by anyone else fly
// off to the RIGHT — that's how you read at a glance which ones you got.

import {
  appleData,
  grapeData,
  kaboomData,
  mushroomData,
  pineappleData,
  skullerData,
  watermelonData,
  type CrewAsset,
} from "@kaplayjs/crew";
import { avatarSrc } from "../../identity";
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
  durationMs: number;
  endsAt: number;
  deadlineAt: number;
  stunMs: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type WireEntity = {
  id: number;
  kind: "fruit" | "bomb";
  /** Crew sprite key (e.g. "apple", "skuller"). */
  sprite: string;
  x: number;
  y: number;
};

type SliceEvent = {
  ev: "sliced" | "boom";
  id: number;
  by: string;
  x: number;
  y: number;
  sprite: string;
};

// Crew sprite key → data URI. Falls back to the skull for unknown keys.
function crewSrc(data: CrewAsset): string {
  return data.kind === "Sprite" ? data.outlined : "";
}
const SPRITE_SRC: Record<string, string> = {
  watermelon: crewSrc(watermelonData),
  apple: crewSrc(appleData),
  pineapple: crewSrc(pineappleData),
  grape: crewSrc(grapeData),
  mushroom: crewSrc(mushroomData),
  skuller: crewSrc(skullerData),
  kaboom: crewSrc(kaboomData),
};
function spriteSrc(key: string): string {
  return SPRITE_SRC[key] ?? SPRITE_SRC.skuller;
}

type StateMsg = {
  type: "state";
  entities: WireEntity[];
  scores: Record<string, number>;
  stuns: Record<string, number>;
  events: SliceEvent[];
  endsAt: number;
  deadlineAt: number;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function createFruitFrenzyMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .ff { display: flex; flex-direction: column; width: 100%; height: 100%;
            background: #0a0a14; color: #f2f2f5; overflow: hidden;
            font-family: inherit; }
      .ff-scores { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;
                   padding: 6px 4px 2px; flex: none; }
      .ff-chip { display: flex; align-items: center; gap: 4px;
                 background: #16162a; border-radius: 12px; padding: 2px 8px 2px 2px;
                 font-size: 13px; color: #9a9aa5; border: 1px solid transparent; }
      .ff-chip img { width: 22px; height: 22px; border-radius: 50%; display: block; }
      .ff-chip.self { color: #f2f2f5; border-color: #abdd64; }
      .ff-chip.leader .ff-chip-score { color: #abdd64; font-weight: 700; }
      .ff-chip-score { font-variant-numeric: tabular-nums; }
      .ff-stage-wrap { flex: 1; display: flex; align-items: center;
                       justify-content: center; min-height: 0; padding: 4px; }
      .ff-stage { position: relative; height: 100%; max-height: 100%;
                  aspect-ratio: 500 / 800; max-width: 100%;
                  background: linear-gradient(#101024, #1a1a30);
                  border-radius: 10px; overflow: hidden;
                  touch-action: none; user-select: none; -webkit-user-select: none; }
      .ff-stage.ff-stunned { box-shadow: inset 0 0 42px 14px rgba(255, 45, 45, 0.6); }
      .ff-ent { position: absolute; left: 0; top: 0;
                cursor: pointer; will-change: transform;
                pointer-events: auto; padding: 8px; margin: -8px; /* ≥48px tap target */ }
      .ff-ent img { width: 48px; height: 48px; display: block;
                    image-rendering: pixelated; pointer-events: none; }
      .ff-pop { position: absolute; left: 0; top: 0; pointer-events: none; }
      .ff-pop img { width: 48px; height: 48px; display: block;
                    image-rendering: pixelated; }
      /* Claimed-fruit fly-off: yours go LEFT, everyone else's go RIGHT. */
      .ff-pop.mine img { animation: ff-fly-left 0.5s ease-out forwards; }
      .ff-pop.theirs img { animation: ff-fly-right 0.5s ease-out forwards; }
      .ff-pop.boom img { animation: ff-boom 0.4s ease-out forwards; }
      @keyframes ff-fly-left {
        0%   { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(1); }
        100% { opacity: 0; transform: translate(-130px, -70px) rotate(-120deg) scale(0.7); }
      }
      @keyframes ff-fly-right {
        0%   { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(1); }
        100% { opacity: 0; transform: translate(130px, -70px) rotate(120deg) scale(0.7); }
      }
      @keyframes ff-boom {
        0%   { opacity: 1; transform: scale(1); }
        100% { opacity: 0; transform: scale(2.4); }
      }
      .ff-status { flex: none; text-align: center; font-size: 14px;
                   color: #9a9aa5; padding: 4px 0 8px; }
      .ff-status .ff-stun-tag { color: #ff5a5a; font-weight: 700; }
    </style>
    <div class="ff">
      <div class="ff-scores" id="ff-scores"></div>
      <div class="ff-stage-wrap"><div class="ff-stage" id="ff-stage"></div></div>
      <div class="ff-status" id="ff-status">get ready…</div>
    </div>
  `;
  const scoresEl = ctx.container.querySelector<HTMLElement>("#ff-scores")!;
  const stageEl = ctx.container.querySelector<HTMLElement>("#ff-stage")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#ff-status")!;

  let fieldW = 500;
  let fieldH = 800;
  let endsAt = 0;
  let built = false;
  let players: WelcomeMsg["players"] = [];
  let myStunnedUntil = 0;
  let lastTapAt = 0;

  const entitySpans = new Map<number, HTMLElement>();
  const chipScoreEls = new Map<string, HTMLElement>();
  const chipEls = new Map<string, HTMLElement>();
  const popTimers = new Set<ReturnType<typeof setTimeout>>();

  function applyWelcome(msg: WelcomeMsg) {
    endsAt = msg.endsAt;
    fieldW = msg.field.w;
    fieldH = msg.field.h;
    if (built) return; // welcome replay on reconnect — keep the scene
    built = true;
    players = msg.players;
    scoresEl.innerHTML = players
      .map(
        (p) => `<div class="ff-chip${p.playerId === ctx.selfPlayerId ? " self" : ""}" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <span class="ff-chip-nick">${escapeHtml(p.nickname)}</span>
          <span class="ff-chip-score">0</span>
        </div>`,
      )
      .join("");
    scoresEl.querySelectorAll<HTMLElement>(".ff-chip").forEach((el) => {
      const pid = el.dataset.pid!;
      chipEls.set(pid, el);
      chipScoreEls.set(pid, el.querySelector<HTMLElement>(".ff-chip-score")!);
    });
  }

  function place(el: HTMLElement, x: number, y: number) {
    const sx = stageEl.clientWidth / fieldW;
    const sy = stageEl.clientHeight / fieldH;
    el.style.transform = `translate(${x * sx}px, ${y * sy}px) translate(-50%, -50%)`;
  }

  function makeEntitySpan(e: WireEntity): HTMLElement {
    const span = document.createElement("span");
    span.className = "ff-ent";
    const img = document.createElement("img");
    img.src = spriteSrc(e.sprite);
    img.alt = "";
    span.appendChild(img);
    if (!ctx.isSpectator) {
      const tap = (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        const now = Date.now();
        if (now - lastTapAt < 80) return; // debounce
        if (now < myStunnedUntil) return; // server ignores these anyway
        lastTapAt = now;
        ctx.send({ type: "slice", id: e.id });
      };
      span.addEventListener("touchstart", tap, { passive: false });
      span.addEventListener("mousedown", tap);
    }
    stageEl.appendChild(span);
    return span;
  }

  function playPop(ev: SliceEvent) {
    const span = document.createElement("span");
    // Direction encodes ownership: your claims fly left, others fly right.
    const dirClass =
      ev.ev === "boom"
        ? "boom"
        : ev.by === ctx.selfPlayerId
          ? "mine"
          : "theirs";
    span.className = `ff-pop ${dirClass}`;
    const img = document.createElement("img");
    img.src = ev.ev === "boom" ? spriteSrc("kaboom") : spriteSrc(ev.sprite);
    img.alt = "";
    span.appendChild(img);
    stageEl.appendChild(span);
    place(span, ev.x, ev.y);
    const t = setTimeout(() => {
      span.remove();
      popTimers.delete(t);
    }, 550);
    popTimers.add(t);
  }

  function applyState(msg: StateMsg) {
    if (!built) return; // never assume welcome arrived first
    endsAt = msg.endsAt;

    // Reconcile entity spans with server state.
    const wantIds = new Set(msg.entities.map((e) => e.id));
    for (const [id, span] of [...entitySpans]) {
      if (!wantIds.has(id)) {
        span.remove();
        entitySpans.delete(id);
      }
    }
    for (const e of msg.entities) {
      let span = entitySpans.get(e.id);
      if (!span) {
        span = makeEntitySpan(e);
        entitySpans.set(e.id, span);
      }
      place(span, e.x, e.y);
    }

    // Pop / boom cues.
    for (const ev of msg.events ?? []) playPop(ev);

    // Stun visual (red arena edges) for the local player.
    myStunnedUntil = msg.stuns?.[ctx.selfPlayerId] ?? 0;
    stageEl.classList.toggle("ff-stunned", Date.now() < myStunnedUntil);

    // Scoreboard.
    let best = -1;
    for (const s of Object.values(msg.scores)) if (s > best) best = s;
    for (const p of players) {
      const s = msg.scores[p.playerId] ?? 0;
      const scoreEl = chipScoreEls.get(p.playerId);
      if (scoreEl) scoreEl.textContent = String(s);
      chipEls.get(p.playerId)?.classList.toggle("leader", s === best && best > 0);
    }

    const myScore = msg.scores[ctx.selfPlayerId] ?? 0;
    ctx.setMatchScore(`${myScore} pts`);
    const stunned = Date.now() < myStunnedUntil;
    statusEl.innerHTML = stunned
      ? `${escapeHtml(statusLine(formatRemaining(endsAt)))} · <span class="ff-stun-tag">STUNNED</span>`
      : escapeHtml(
          statusLine(formatRemaining(endsAt), "tap fruit · dodge bombs"),
        );
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      for (const t of popTimers) clearTimeout(t);
      popTimers.clear();
      entitySpans.clear();
      ctx.container.innerHTML = "";
    },
  };
}

const FruitFrenzyClient: MiniGameClientDefinition = {
  id: "fruit-frenzy",
  controlsHint: "tap fruit first to claim it — bombs cost 3 and stun you!",
  createMatch: createFruitFrenzyMatchClient,
};

registerMiniGameClient(FruitFrenzyClient);

export default FruitFrenzyClient;
