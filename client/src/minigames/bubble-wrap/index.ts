// Bubble Wrap client. Your own 6×9 CSS grid of round bubbles — pop them as
// fast as you can. Pops fire on touchstart with zero debounce (each bubble
// pops once, so no dedupe is needed beyond the popped state), and swiping
// across the sheet pops every bubble the finger crosses (touchmove +
// elementFromPoint). Big own-progress readout up top; everyone else's
// progress as a live avatar list with thin bars.
//
// The server broadcasts each player's popped-bitmask (hex) so a reconnect
// (welcome replay + next state) restores the sheet exactly.

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
  grid: { cols: number; rows: number; total: number };
  graceMs: number;
  startAt: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  counts: Record<string, number>;
  finishedAt: Record<string, number>;
  grids: Record<string, string>;
  graceEndsAt: number;
  deadlineAt: number;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Decode the server's 7-byte hex popped-bitmask (LSB-first). */
function maskBit(hex: string, index: number): boolean {
  const byte = parseInt(hex.slice((index >> 3) * 2, (index >> 3) * 2 + 2), 16);
  if (!Number.isFinite(byte)) return false;
  return (byte & (1 << (index & 7))) !== 0;
}

function createBubbleWrapMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .bw { display: flex; flex-direction: column; width: 100%; height: 100%;
            background: #0a0a14; color: #f2f2f5; overflow: hidden;
            font-family: inherit; }
      .bw-top { flex: none; display: flex; gap: 10px; align-items: center;
                padding: 8px 10px 4px; }
      .bw-own { flex: none; text-align: center; }
      .bw-count { font-size: 30px; font-weight: 800; line-height: 1;
                  font-variant-numeric: tabular-nums; }
      .bw-count.done { color: #abdd64; }
      .bw-clock { font-size: 12px; color: #9a9aa5; margin-top: 2px; }
      .bw-others { flex: 1; min-width: 0; display: flex; flex-direction: column;
                   gap: 3px; max-height: 76px; overflow-y: auto; }
      .bw-row { display: flex; align-items: center; gap: 6px; font-size: 12px;
                color: #9a9aa5; min-width: 0; }
      .bw-row img { width: 18px; height: 18px; border-radius: 50%; flex: none; }
      .bw-row .bw-nick { flex: none; max-width: 72px; overflow: hidden;
                         text-overflow: ellipsis; white-space: nowrap; }
      .bw-row .bw-bar { flex: 1; height: 4px; background: #1c1c30;
                        border-radius: 2px; overflow: hidden; min-width: 20px; }
      .bw-row .bw-bar-fill { height: 100%; width: 0%; background: #abdd64;
                             border-radius: 2px; transition: width 0.15s linear; }
      .bw-row .bw-num { flex: none; font-variant-numeric: tabular-nums; }
      .bw-row.finished { color: #abdd64; }
      .bw-row.finished .bw-bar-fill { background: #abdd64; }
      .bw-grid { flex: 1; display: grid; min-height: 0;
                 grid-template-columns: repeat(6, 1fr);
                 grid-template-rows: repeat(9, 1fr);
                 gap: 5px; padding: 6px 8px 10px;
                 touch-action: none; user-select: none; -webkit-user-select: none; }
      .bw-bubble { appearance: none; border: none; padding: 0; margin: 0;
                   min-width: 0; min-height: 0; border-radius: 50%;
                   background: radial-gradient(circle at 32% 30%, #4a4a6e, #2b2b45 65%, #22223a);
                   box-shadow: inset -2px -3px 6px rgba(0,0,0,0.35),
                               inset 2px 3px 6px rgba(255,255,255,0.08);
                   transition: transform 0.12s ease-out, background 0.12s ease-out,
                               box-shadow 0.12s ease-out;
                   cursor: pointer; -webkit-tap-highlight-color: transparent; }
      .bw-bubble.popped { transform: scale(0.62);
                          background: #15151f; box-shadow: none;
                          pointer-events: none; }
      .bw.spectating .bw-grid { opacity: 0.35; pointer-events: none; }
      .bw-banner { flex: none; text-align: center; font-size: 14px;
                   color: #9a9aa5; padding: 0 0 8px; }
      .bw-banner .bw-done-tag { color: #abdd64; font-weight: 800; }
      .bw-banner .bw-grace-tag { color: #ffcf5a; font-weight: 700; }
    </style>
    <div class="bw" id="bw-root">
      <div class="bw-top">
        <div class="bw-own">
          <div class="bw-count" id="bw-count">0/54</div>
          <div class="bw-clock" id="bw-clock"></div>
        </div>
        <div class="bw-others" id="bw-others"></div>
      </div>
      <div class="bw-grid" id="bw-grid"></div>
      <div class="bw-banner" id="bw-banner">pop 'em all!</div>
    </div>
  `;
  const rootEl = ctx.container.querySelector<HTMLElement>("#bw-root")!;
  const countEl = ctx.container.querySelector<HTMLElement>("#bw-count")!;
  const clockEl = ctx.container.querySelector<HTMLElement>("#bw-clock")!;
  const othersEl = ctx.container.querySelector<HTMLElement>("#bw-others")!;
  const gridEl = ctx.container.querySelector<HTMLElement>("#bw-grid")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#bw-banner")!;

  let built = false;
  let total = 54;
  let startAt = 0;
  let players: WelcomeMsg["players"] = [];
  let myCount = 0;
  let iAmDone = false;
  const popped: boolean[] = [];
  const bubbleEls: HTMLButtonElement[] = [];
  const rowEls = new Map<string, { row: HTMLElement; fill: HTMLElement; num: HTMLElement }>();

  const amPlayer =
    !ctx.isSpectator &&
    ctx.participants.some((p) => p.playerId === ctx.selfPlayerId);

  /** Pop bubble `idx` visually; if it's a fresh local pop, tell the server. */
  function pop(idx: number, fromServer: boolean) {
    if (idx < 0 || idx >= total || popped[idx]) return;
    // Warm-up: the server ignores pops before GO, so don't deflate locally
    // either — an early tap would desync the sheet forever.
    if (!fromServer && Date.now() < startAt) return;
    popped[idx] = true;
    bubbleEls[idx]?.classList.add("popped");
    if (!fromServer && amPlayer) ctx.send({ type: "pop", index: idx });
  }

  function bubbleIndexAt(clientX: number, clientY: number): number {
    const el = document.elementFromPoint(clientX, clientY);
    const btn = el?.closest?.(".bw-bubble") as HTMLElement | null;
    if (!btn || !gridEl.contains(btn)) return -1;
    const idx = Number(btn.dataset.index);
    return Number.isFinite(idx) ? idx : -1;
  }

  function bindInputs() {
    // Zero-debounce pops on touchstart; swipes pop everything they cross.
    const onTouch = (e: TouchEvent) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        pop(bubbleIndexAt(t.clientX, t.clientY), false);
      }
    };
    gridEl.addEventListener("touchstart", onTouch, { passive: false });
    gridEl.addEventListener("touchmove", onTouch, { passive: false });
    // Mouse fallback: press pops, dragging with the button held pops too.
    gridEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pop(bubbleIndexAt(e.clientX, e.clientY), false);
    });
    gridEl.addEventListener("mousemove", (e) => {
      if ((e.buttons & 1) === 0) return;
      pop(bubbleIndexAt(e.clientX, e.clientY), false);
    });
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (built) return; // welcome replay on reconnect — keep the scene
    built = true;
    total = msg.grid.total;
    startAt = msg.startAt;
    players = msg.players;

    gridEl.style.gridTemplateColumns = `repeat(${msg.grid.cols}, 1fr)`;
    gridEl.style.gridTemplateRows = `repeat(${msg.grid.rows}, 1fr)`;
    const cells: string[] = [];
    for (let i = 0; i < total; i++) {
      cells.push(`<button class="bw-bubble" type="button" data-index="${i}" tabindex="-1"></button>`);
      popped.push(false);
    }
    gridEl.innerHTML = cells.join("");
    gridEl.querySelectorAll<HTMLButtonElement>(".bw-bubble").forEach((b) => {
      bubbleEls[Number(b.dataset.index)] = b;
    });

    // Live progress list: everyone except the local player (spectators see
    // the full roster — they have no sheet of their own).
    const listed = players.filter((p) => p.playerId !== ctx.selfPlayerId);
    othersEl.innerHTML = listed
      .map(
        (p) => `<div class="bw-row" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <span class="bw-nick">${escapeHtml(p.nickname)}</span>
          <span class="bw-bar"><span class="bw-bar-fill"></span></span>
          <span class="bw-num">0</span>
        </div>`,
      )
      .join("");
    othersEl.querySelectorAll<HTMLElement>(".bw-row").forEach((row) => {
      rowEls.set(row.dataset.pid!, {
        row,
        fill: row.querySelector<HTMLElement>(".bw-bar-fill")!,
        num: row.querySelector<HTMLElement>(".bw-num")!,
      });
    });

    countEl.textContent = `0/${total}`;
    if (amPlayer) {
      bindInputs();
    } else {
      rootEl.classList.add("spectating");
      bannerEl.textContent = "spectating";
    }
  }

  function applyState(msg: StateMsg) {
    if (!built) return; // never assume welcome arrived first

    // Resync own sheet from the server bitmask (reconnect / dropped sends).
    if (amPlayer) {
      const myGrid = msg.grids?.[ctx.selfPlayerId];
      if (typeof myGrid === "string" && myGrid.length >= Math.ceil(total / 8) * 2) {
        for (let i = 0; i < total; i++) {
          if (!popped[i] && maskBit(myGrid, i)) pop(i, true);
        }
      }
    }

    myCount = msg.counts[ctx.selfPlayerId] ?? 0;
    // Optimistic display: local pops the server hasn't echoed yet still count.
    const localCount = popped.filter(Boolean).length;
    const shown = Math.max(myCount, localCount);
    iAmDone = amPlayer && (msg.finishedAt[ctx.selfPlayerId] ?? 0) > 0;
    countEl.textContent = `${shown}/${total}`;
    countEl.classList.toggle("done", shown >= total);
    ctx.setMatchScore(amPlayer ? `${shown}/${total}` : null);

    for (const [pid, els] of rowEls) {
      const c = msg.counts[pid] ?? 0;
      const done = (msg.finishedAt[pid] ?? 0) > 0;
      els.num.textContent = done ? "✓" : String(c);
      els.fill.style.width = `${Math.min(100, (c / total) * 100)}%`;
      els.row.classList.toggle("finished", done);
    }

    clockEl.textContent = formatRemaining(msg.deadlineAt);
    const graceLeft =
      msg.graceEndsAt > 0
        ? Math.max(0, Math.ceil((msg.graceEndsAt - Date.now()) / 1000))
        : 0;
    if (iAmDone || (amPlayer && shown >= total)) {
      bannerEl.innerHTML = `<span class="bw-done-tag">DONE!</span> ${
        msg.graceEndsAt > 0 ? `match ends in ${graceLeft}s` : ""
      }`;
    } else if (msg.graceEndsAt > 0) {
      bannerEl.innerHTML = `<span class="bw-grace-tag">someone finished — ${graceLeft}s left!</span>`;
    } else if (amPlayer) {
      bannerEl.textContent = statusLine("pop 'em all!", "swipe works too");
    }
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      rowEls.clear();
      bubbleEls.length = 0;
      ctx.container.innerHTML = "";
    },
  };
}

const BubbleWrapClient: MiniGameClientDefinition = {
  id: "bubble-wrap",
  controlsHint: "pop all 54 bubbles as fast as you can — swiping pops too!",
  createMatch: createBubbleWrapMatchClient,
};

registerMiniGameClient(BubbleWrapClient);

export default BubbleWrapClient;
