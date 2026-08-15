// Don't Let Go client. Pure DOM. A crew-heart dot wanders the stage; the
// player must keep a finger (or held mouse) within the contact radius of the
// dot at all times. Contact state is reported to the server as an idempotent
// set: an edge message on change PLUS a re-send every 100ms (addendum rule 4).
//
// The dot accelerates relentlessly — the endgame is losing a physical race,
// not falling for a trick.
//
// Ring states: green while in contact, amber while the grace window burns,
// red flash + shake on elimination. Spectators just watch the dot + roster.

import { heartData } from "@kaplayjs/crew";
import { avatarSrc } from "../../identity";
import { formatRemaining, statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

const HEART_SRC = heartData.kind === "Sprite" ? heartData.outlined : "";

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  dot: { radius: number; contactRadius: number };
  graceMs: number;
  startAt: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  dot: { x: number; y: number };
  alive: string[];
  deadlineAt: number;
};

function createDontLetGoMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .dlg { position: absolute; inset: 0; display: flex; flex-direction: column;
        background: #0a0a14; color: #f2f2f5; overflow: hidden;
        user-select: none; -webkit-user-select: none; touch-action: none; }
      .dlg-top { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;
        padding: 8px 10px 2px; }
      .dlg-cell { position: relative; width: 38px; text-align: center;
        transition: opacity .3s; }
      .dlg-cell img { width: 36px; height: 36px; border-radius: 50%; display: block;
        margin: 0 auto; background: #16162a; }
      .dlg-cell.dlg-self img { outline: 2px solid #abdd64; }
      .dlg-cell.dlg-out { opacity: .3; }
      .dlg-cell.dlg-out img { filter: grayscale(1); }
      .dlg-you { font-size: 8px; font-weight: 700; color: #abdd64; line-height: 10px; }
      .dlg-status { text-align: center; font-size: 13px; color: #9a9aa5;
        padding: 3px 0 6px; min-height: 19px; }
      .dlg-stage { position: relative; flex: 1; margin: 0 10px 10px;
        border: 1px solid #26263a; border-radius: 12px; background: #10101e;
        overflow: hidden; touch-action: none; }
      .dlg-banner { position: absolute; left: 0; right: 0; bottom: 10px;
        text-align: center; font-size: 14px; color: #9a9aa5;
        pointer-events: none; z-index: 3; }
      .dlg-banner.dlg-urgent { color: #fbbf24; font-weight: 700;
        animation: dlg-blink .35s steps(2) infinite; }
      @keyframes dlg-blink { 50% { opacity: .35; } }
      .dlg-dot { position: absolute; width: 15.2%; aspect-ratio: 1;
        transform: translate(-50%, -50%); border-radius: 50%;
        border: 4px solid #4ade80; background: rgba(171, 221, 100, .12);
        box-shadow: 0 0 18px rgba(74, 222, 128, .35);
        display: flex; align-items: center; justify-content: center;
        pointer-events: none; z-index: 2; }
      .dlg-dot img { width: 62%; height: 62%; object-fit: contain;
        image-rendering: pixelated; pointer-events: none; }
      .dlg-dot.dlg-grace { border-color: #fbbf24;
        background: rgba(251, 191, 36, .15);
        box-shadow: 0 0 18px rgba(251, 191, 36, .5);
        animation: dlg-pulse .25s ease-in-out infinite alternate; }
      @keyframes dlg-pulse { from { transform: translate(-50%, -50%) scale(1); }
        to { transform: translate(-50%, -50%) scale(1.12); } }
      .dlg-dot.dlg-dead { border-color: #ef4444;
        background: rgba(239, 68, 68, .2);
        box-shadow: 0 0 24px rgba(239, 68, 68, .6); }
      .dlg-stage.dlg-shake { animation: dlg-shake .5s ease-in-out; }
      @keyframes dlg-shake {
        0%, 100% { transform: translateX(0); }
        15% { transform: translateX(-10px); } 30% { transform: translateX(9px); }
        45% { transform: translateX(-7px); } 60% { transform: translateX(6px); }
        75% { transform: translateX(-4px); } 90% { transform: translateX(2px); } }
      .dlg-redflash { position: absolute; inset: 0; background: #ef4444;
        opacity: 0; pointer-events: none; z-index: 4; }
      .dlg-redflash.dlg-show { animation: dlg-red .5s ease-out; }
      @keyframes dlg-red { 0% { opacity: .55; } 100% { opacity: 0; } }
    </style>
    <div class="dlg">
      <div class="dlg-top"></div>
      <div class="dlg-status"></div>
      <div class="dlg-stage">
        <div class="dlg-dot">
          <img src="${HEART_SRC}" alt="" draggable="false" />
        </div>
        <div class="dlg-redflash"></div>
        <div class="dlg-banner"></div>
      </div>
    </div>
  `;
  const topEl = ctx.container.querySelector<HTMLElement>(".dlg-top")!;
  const statusEl = ctx.container.querySelector<HTMLElement>(".dlg-status")!;
  const stageEl = ctx.container.querySelector<HTMLElement>(".dlg-stage")!;
  const dotEl = ctx.container.querySelector<HTMLElement>(".dlg-dot")!;
  const redFlashEl = ctx.container.querySelector<HTMLElement>(".dlg-redflash")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>(".dlg-banner")!;
  const flash = createMatchFlash(stageEl);

  let cfg = { fieldW: 500, fieldH: 800, contactRadius: 70 };
  let roster: WelcomeMsg["players"] = [];
  let built = false;
  let dotX = cfg.fieldW / 2;
  let dotY = cfg.fieldH / 2;
  let deadlineAt = 0;
  let prevAlive: Set<string> | null = null;
  let selfAlive = !ctx.isSpectator;
  let lastSentOn: boolean | null = null;

  const cellByPlayerId = new Map<string, HTMLElement>();

  // ---- pointer tracking (participants only) --------------------------------
  const touchPoints: { fx: number; fy: number }[] = [];
  let mouseDown = false;
  let mouseFx = 0;
  let mouseFy = 0;

  function toField(clientX: number, clientY: number, r: DOMRect) {
    return {
      fx: ((clientX - r.left) / Math.max(1, r.width)) * cfg.fieldW,
      fy: ((clientY - r.top) / Math.max(1, r.height)) * cfg.fieldH,
    };
  }

  function evaluateContact(): boolean {
    const r2 = cfg.contactRadius * cfg.contactRadius;
    for (const t of touchPoints) {
      const dx = t.fx - dotX;
      const dy = t.fy - dotY;
      if (dx * dx + dy * dy <= r2) return true;
    }
    if (mouseDown) {
      const dx = mouseFx - dotX;
      const dy = mouseFy - dotY;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  /** Report contact: edge on change, full re-send when `force` (100ms tick). */
  function reportContact(force: boolean) {
    if (ctx.isSpectator) return;
    const on = evaluateContact();
    updateRing(on);
    if (!selfAlive) return;
    if (force || on !== lastSentOn) {
      lastSentOn = on;
      ctx.send({ type: "contact", on });
    }
  }

  function updateRing(on: boolean) {
    if (ctx.isSpectator) return;
    dotEl.classList.toggle("dlg-dead", !selfAlive);
    dotEl.classList.toggle("dlg-grace", selfAlive && !on);
    if (selfAlive) {
      if (on) {
        bannerEl.textContent = "don't let go…";
        bannerEl.classList.remove("dlg-urgent");
      } else {
        bannerEl.textContent = "⚠ GET BACK ON THE DOT ⚠";
        bannerEl.classList.add("dlg-urgent");
      }
    }
  }

  const onTouch = (e: TouchEvent) => {
    if (e.type === "touchstart" || e.type === "touchmove") e.preventDefault();
    touchPoints.length = 0;
    const r = stageEl.getBoundingClientRect();
    for (let i = 0; i < e.touches.length; i++) {
      const t = e.touches[i];
      touchPoints.push(toField(t.clientX, t.clientY, r));
    }
    reportContact(false);
  };
  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    mouseDown = true;
    const p = toField(e.clientX, e.clientY, stageEl.getBoundingClientRect());
    mouseFx = p.fx;
    mouseFy = p.fy;
    reportContact(false);
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!mouseDown) return;
    const p = toField(e.clientX, e.clientY, stageEl.getBoundingClientRect());
    mouseFx = p.fx;
    mouseFy = p.fy;
    reportContact(false);
  };
  const onMouseUp = () => {
    mouseDown = false;
    reportContact(false);
  };

  let resendTimer: ReturnType<typeof setInterval> | null = null;
  if (!ctx.isSpectator) {
    stageEl.addEventListener("touchstart", onTouch, { passive: false });
    stageEl.addEventListener("touchmove", onTouch, { passive: false });
    stageEl.addEventListener("touchend", onTouch);
    stageEl.addEventListener("touchcancel", onTouch);
    stageEl.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    // Addendum rule 4: re-send current contact state every 100ms.
    resendTimer = setInterval(() => reportContact(true), 100);
  } else {
    bannerEl.textContent = "spectating";
  }

  // ---- rendering -----------------------------------------------------------
  function buildTop() {
    topEl.innerHTML = roster
      .map(
        (p) => `<div class="dlg-cell${
          p.playerId === ctx.selfPlayerId ? " dlg-self" : ""
        }" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" draggable="false" />
          ${p.playerId === ctx.selfPlayerId ? `<div class="dlg-you">YOU</div>` : ""}
        </div>`,
      )
      .join("");
    cellByPlayerId.clear();
    topEl.querySelectorAll<HTMLElement>(".dlg-cell").forEach((el) => {
      cellByPlayerId.set(el.dataset.pid!, el);
    });
  }

  function positionDot() {
    dotEl.style.left = `${((dotX / cfg.fieldW) * 100).toFixed(2)}%`;
    dotEl.style.top = `${((dotY / cfg.fieldH) * 100).toFixed(2)}%`;
  }

  function nickOf(pid: string): string {
    return roster.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  function applyWelcome(msg: WelcomeMsg) {
    cfg = {
      fieldW: msg.field?.w || 500,
      fieldH: msg.field?.h || 800,
      contactRadius: msg.dot?.contactRadius || 70,
    };
    roster = msg.players;
    deadlineAt = msg.deadlineAt;
    if (!built) {
      built = true;
      buildTop();
      positionDot();
      if (!ctx.isSpectator) updateRing(evaluateContact());
    }
  }

  function applyState(msg: StateMsg) {
    dotX = msg.dot.x;
    dotY = msg.dot.y;
    positionDot();
    deadlineAt = msg.deadlineAt;

    const aliveSet = new Set(msg.alive);

    // Elimination cues — diff against the previous alive set.
    if (prevAlive) {
      for (const pid of prevAlive) {
        if (!aliveSet.has(pid)) {
          if (pid === ctx.selfPlayerId) {
            selfAlive = false;
            flash.flash("💀 YOU LET GO");
            dotEl.classList.add("dlg-dead");
            dotEl.classList.remove("dlg-grace");
            redFlashEl.classList.remove("dlg-show");
            void redFlashEl.offsetWidth; // restart animation
            redFlashEl.classList.add("dlg-show");
            stageEl.classList.remove("dlg-shake");
            void stageEl.offsetWidth;
            stageEl.classList.add("dlg-shake");
            bannerEl.textContent = "you're out";
            bannerEl.classList.remove("dlg-urgent");
          } else {
            flash.flash(`💀 ${nickOf(pid)} let go`);
          }
        }
      }
    }
    prevAlive = aliveSet;
    if (!ctx.isSpectator) selfAlive = aliveSet.has(ctx.selfPlayerId);

    for (const p of roster) {
      const cell = cellByPlayerId.get(p.playerId);
      if (cell) cell.classList.toggle("dlg-out", !aliveSet.has(p.playerId));
    }

    const holding = `${msg.alive.length}/${roster.length || msg.alive.length} holding`;
    ctx.setMatchScore(holding);
    statusEl.textContent = statusLine(holding, formatRemaining(deadlineAt));

    // The dot moved — a stationary finger may have fallen off (or caught up).
    if (!ctx.isSpectator && selfAlive) reportContact(false);
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      if (resendTimer) clearInterval(resendTimer);
      resendTimer = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

const DontLetGoClient: MiniGameClientDefinition = {
  id: "dont-let-go",
  controlsHint: "finger ON the dot and follow it — it only gets faster. never lift!",
  createMatch: createDontLetGoMatchClient,
};

registerMiniGameClient(DontLetGoClient);

export default DontLetGoClient;
