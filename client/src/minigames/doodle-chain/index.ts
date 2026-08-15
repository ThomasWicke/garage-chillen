// Doodle Chain client. Pure DOM + a 2D canvas for drawing.
//
//   prompt — type a word / short phrase, SUBMIT
//   draw   — "draw: <text>" above a square canvas; 9 colours (last one is
//            the eraser), 3 brush sizes (the big one erases well), undo,
//            DONE. Strokes are sent
//            one by one as you lift the finger.
//   guess  — the drawing you received above an input, SUBMIT
//   album  — chains replayed step by step: previous entry small, current
//            entry big; on drawings AND guesses everyone but the author
//            taps ♥ or "no ♥" — the step advances once all have answered
//   results— hearts ranking
//
// Content for the current step comes in a per-player `task` message; if
// the phone doesn't have one for the current step (reconnect) it asks.

import { avatarSrc } from "../../identity";
import { statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "prompt" | "draw" | "guess" | "album" | "results" | "ended";
type StepKind = "prompt" | "draw" | "guess";
type Stroke = { c: number; w: number; p: number[] };

type WelcomeMsg = {
  type: "welcome";
  chainLength: number;
  scoring: { match: number };
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  stepIndex: number;
  chainLength: number;
  phaseEndsAt: number;
  deadlineAt: number;
  doneIds: string[];
  connected: string[];
  album: { chain: number; step: number; total: number } | null;
  likes: Record<string, number>;
  albumResponded: string[];
  points: Record<string, number>;
};

type TaskMsg = {
  type: "task";
  stepIndex: number;
  chain: number;
  kind: StepKind;
  input:
    | { kind: "draw"; strokes: Stroke[]; by: string }
    | { kind: "text"; text: string; by: string }
    | null;
  mine: { text: string; strokes: Stroke[]; done: boolean };
};

type AlbumEntry = {
  kind: StepKind;
  playerId: string;
  text: string;
  strokes: Stroke[];
  auto: boolean;
};
type AlbumMsg = {
  type: "album";
  chain: number;
  step: number;
  chainLength: number;
  totalChains: number;
  startedBy: string;
  entries: AlbumEntry[];
};

const COLORS = [
  "#111111",
  "#e0596a",
  "#f5a623",
  "#ffd05d",
  "#4caf50",
  "#3b82f6",
  "#a855f7",
  "#8b5a2b",
  "#ffffff", // eraser
];
const WIDTHS = [8, 22, 70]; // logical units (canvas is 1000×1000)
const COORD_MAX = 1000;
const MIN_POINT_DIST = 4;
const MAX_STROKE_POINTS = 200;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function secs(at: number): number {
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** Paint strokes onto a canvas (white ground). `cssPx` = displayed size. */
function paintStrokes(canvas: HTMLCanvasElement, strokes: Stroke[], cssPx: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.max(1, Math.round(cssPx * dpr));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  canvas.style.width = `${cssPx}px`;
  canvas.style.height = `${cssPx}px`;
  const g = canvas.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, px, px);
  const k = px / COORD_MAX;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const s of strokes) paintOne(g, s, k);
}

function paintOne(g: CanvasRenderingContext2D, s: Stroke, k: number) {
  g.strokeStyle = COLORS[s.c] ?? COLORS[0];
  g.fillStyle = g.strokeStyle;
  g.lineWidth = (WIDTHS[s.w] ?? WIDTHS[1]) * k;
  const p = s.p;
  if (p.length < 4) {
    g.beginPath();
    g.arc(p[0] * k, p[1] * k, g.lineWidth / 2, 0, Math.PI * 2);
    g.fill();
    return;
  }
  g.beginPath();
  g.moveTo(p[0] * k, p[1] * k);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * k, p[i + 1] * k);
  g.stroke();
}

function createDoodleChainMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="dc-root" id="dc-root">
      <style>
        .dc-root {
          position: relative;
          box-sizing: border-box;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 10px 12px 12px;
          background: #0a0a14;
          color: #f2f2f5;
          overflow: hidden;
          text-align: center;
        }
        .dc-root [hidden] { display: none !important; }
        .dc-status { font-size: 13px; color: #9a9aa5; }
        .dc-head { display: flex; align-items: center; gap: 10px; width: 100%; }
        .dc-head-txt { flex: 1; min-width: 0; text-align: left; }
        .dc-banner {
          font-size: clamp(16px, 5vw, 22px);
          font-weight: 800;
          color: #abdd64;
          line-height: 1.15;
          overflow-wrap: anywhere;
        }
        .dc-sub { font-size: 12px; color: #9a9aa5; min-height: 1.2em; }
        .dc-count {
          font-size: clamp(22px, 8vw, 32px);
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          min-width: 1.6em;
          text-align: right;
        }
        .dc-count.dc-hurry { color: #e0596a; }

        .dc-canvas-wrap { position: relative; line-height: 0; }
        .dc-canvas {
          border-radius: 12px;
          border: 3px solid #2a2a3a;
          background: #fff;
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
          display: block;
        }
        .dc-canvas.dc-drawable { cursor: crosshair; }
        .dc-tools {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          justify-content: center;
          align-items: center;
          max-width: 100%;
        }
        .dc-swatch {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 3px solid #2a2a3a;
          -webkit-tap-highlight-color: transparent;
          position: relative;
        }
        .dc-swatch.on { border-color: #abdd64; transform: scale(1.12); }
        .dc-swatch[data-color="8"]::after {
          content: "⌫";
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          color: #111;
        }
        .dc-size {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          border: 2px solid #2a2a3a;
          background: #14141f;
          display: flex;
          align-items: center;
          justify-content: center;
          -webkit-tap-highlight-color: transparent;
        }
        .dc-size.on { border-color: #abdd64; }
        .dc-size .dc-dot { display: block; border-radius: 50%; background: #f2f2f5; flex: none; }
        .dc-tool {
          font-family: inherit;
          font-size: 13px;
          font-weight: 800;
          padding: 6px 10px;
          border-radius: 8px;
          border: 2px solid #2a2a3a;
          background: #14141f;
          color: #f2f2f5;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .dc-btn {
          font-family: inherit;
          font-size: 17px;
          font-weight: 800;
          padding: 11px 18px;
          border-radius: 12px;
          border: 3px solid #abdd64;
          background: #abdd64;
          color: #0a0a14;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .dc-btn:disabled { opacity: 0.35; }
        .dc-btn.dc-ghost { background: transparent; color: #abdd64; }
        .dc-form { display: flex; flex-direction: column; gap: 8px; width: 100%; align-items: stretch; }
        .dc-form input {
          font-family: inherit;
          font-size: 19px;
          padding: 11px 14px;
          background: #14141f;
          color: #f2f2f5;
          border: 2px solid #2a2a3a;
          border-radius: 10px;
          outline: none;
          width: 100%;
          text-align: center;
          -webkit-user-select: text;
          user-select: text;
          touch-action: manipulation;
        }
        .dc-form input:focus { border-color: #abdd64; }
        .dc-form input:disabled { opacity: 0.6; }
        .dc-note { font-size: 12px; color: #9a9aa5; }
        .dc-wait { font-size: 15px; color: #9a9aa5; padding: 20px 0; }

        /* album */
        .dc-album {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          width: 100%;
          flex: 1;
          min-height: 0;
        }
        .dc-album-prev {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #14141f;
          border: 2px solid #2a2a3a;
          border-radius: 10px;
          padding: 6px 8px;
          font-size: 13px;
          max-width: 100%;
          color: #9a9aa5;
        }
        .dc-album-prev canvas { border-radius: 6px; }
        .dc-album-prev .dc-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60vw; }
        .dc-album-cur {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          animation: dc-pop 0.3s ease-out;
        }
        @keyframes dc-pop {
          from { transform: scale(0.9); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .dc-album-by {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          color: #9a9aa5;
        }
        .dc-album-by img { width: 24px; height: 24px; border-radius: 6px; }
        .dc-album-text {
          font-size: clamp(20px, 7vw, 30px);
          font-weight: 800;
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 14px;
          padding: 16px 18px;
          max-width: 92vw;
          overflow-wrap: anywhere;
        }
        .dc-album-text.dc-auto { color: #9a9aa5; }
        .dc-album-text.dc-match { border-color: #abdd64; color: #abdd64; }
        .dc-like {
          font-family: inherit;
          font-size: 16px;
          font-weight: 800;
          padding: 8px 16px;
          border-radius: 12px;
          border: 3px solid #e0596a;
          background: transparent;
          color: #e0596a;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .dc-like.dc-liked, .dc-like:disabled { opacity: 0.5; }
        .dc-like.dc-liked { background: #e0596a; color: #fff; opacity: 1; }
        .dc-like.dc-pass { border-color: #2a2a3a; color: #9a9aa5; }
        .dc-like.dc-pass.dc-picked { background: #2a2a3a; color: #f2f2f5; opacity: 1; }
        .dc-resp { font-size: 12px; color: #9a9aa5; }
        .dc-album-actions { display: flex; gap: 8px; align-items: center; justify-content: center; }

        /* results */
        .dc-results {
          display: flex;
          flex-direction: column;
          gap: 6px;
          width: min(360px, 94%);
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 16px;
          padding: 12px 10px;
          animation: dc-pop 0.35s ease-out;
        }
        .dc-res-row { display: flex; align-items: center; gap: 8px; font-size: 15px; text-align: left; }
        .dc-res-row img { width: 30px; height: 30px; border-radius: 7px; }
        .dc-res-row .dc-rank { width: 1.6em; color: #9a9aa5; font-variant-numeric: tabular-nums; }
        .dc-res-row .dc-nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dc-res-row .dc-p { font-weight: 800; color: #e0596a; }
        .dc-res-row.dc-top .dc-nm { color: #ffd05d; font-weight: 700; }
      </style>
      <div class="dc-status" id="dc-status"></div>
      <div class="dc-head">
        <div class="dc-head-txt">
          <div class="dc-banner" id="dc-banner"></div>
          <div class="dc-sub" id="dc-sub"></div>
        </div>
        <div class="dc-count" id="dc-count"></div>
      </div>
      <div class="dc-wait" id="dc-wait" hidden>…</div>
      <div class="dc-canvas-wrap" id="dc-canvas-wrap" hidden><canvas class="dc-canvas" id="dc-canvas"></canvas></div>
      <div class="dc-tools" id="dc-tools" hidden></div>
      <div class="dc-form" id="dc-form" hidden></div>
      <div id="dc-actions" hidden></div>
      <div class="dc-album" id="dc-album" hidden></div>
      <div class="dc-results" id="dc-results" hidden></div>
    </div>
  `;
  const $ = <T extends HTMLElement>(id: string) =>
    ctx.container.querySelector<T>(`#${id}`)!;
  const rootEl = $("dc-root");
  const statusEl = $("dc-status");
  const bannerEl = $("dc-banner");
  const subEl = $("dc-sub");
  const countEl = $("dc-count");
  const waitEl = $("dc-wait");
  const canvasWrap = $("dc-canvas-wrap");
  const canvas = $<HTMLCanvasElement>("dc-canvas");
  const toolsEl = $("dc-tools");
  const formEl = $("dc-form");
  const actionsEl = $("dc-actions");
  const albumEl = $("dc-album");
  const resultsEl = $("dc-results");
  const flash = createMatchFlash(rootEl);

  let players: WelcomeMsg["players"] = [];
  let amParticipant = false;
  let currentState: StateMsg | null = null;
  let task: TaskMsg | null = null;
  let album: AlbumMsg | null = null;
  let lastTaskReqAt = 0;
  let lastAlbumReqAt = 0;
  let viewKey = "";
  let submitted = false;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  const liked = new Set<string>();
  /** "c:s" keys this phone already answered (♥ or no ♥) — one answer, final. */
  const responded = new Map<string, "like" | "pass">();
  let flashed = false;
  let resultsBuilt = false;

  // drawing state
  let myStrokes: Stroke[] = [];
  let color = 0;
  let width = 1;
  let drawing: Stroke | null = null;
  let lastX = 0;
  let lastY = 0;
  let canvasPx = 300;

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }
  function avatarOf(pid: string): string {
    return players.find((p) => p.playerId === pid)?.avatarId ?? "";
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    amParticipant =
      !ctx.isSpectator && players.some((p) => p.playerId === ctx.selfPlayerId);
    bannerEl.textContent = "DOODLE CHAIN";
    subEl.textContent = "";
  }

  // ─── canvas sizing ──────────────────────────────────────────────────────

  function fitCanvas(reserve: number): number {
    const w = rootEl.clientWidth - 24;
    const h = rootEl.clientHeight - reserve;
    return Math.max(160, Math.min(440, w, h));
  }

  // ─── drawing input ──────────────────────────────────────────────────────

  function canvasPoint(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * COORD_MAX;
    const y = ((e.clientY - r.top) / r.height) * COORD_MAX;
    return [
      Math.max(0, Math.min(COORD_MAX, Math.round(x))),
      Math.max(0, Math.min(COORD_MAX, Math.round(y))),
    ];
  }

  function canDraw(): boolean {
    const st = currentState;
    return (
      !!st &&
      st.phase === "draw" &&
      !!task &&
      task.stepIndex === st.stepIndex &&
      task.kind === "draw" &&
      amParticipant &&
      !submitted
    );
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!canDraw()) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic / already-released pointer */
    }
    const [x, y] = canvasPoint(e);
    drawing = { c: color, w: width, p: [x, y] };
    lastX = x;
    lastY = y;
    const g = canvas.getContext("2d")!;
    paintOne(g, drawing, canvas.width / COORD_MAX);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    e.preventDefault();
    const [x, y] = canvasPoint(e);
    if (Math.hypot(x - lastX, y - lastY) < MIN_POINT_DIST) return;
    if (drawing.p.length >= MAX_STROKE_POINTS * 2) return;
    drawing.p.push(x, y);
    const g = canvas.getContext("2d")!;
    const k = canvas.width / COORD_MAX;
    g.strokeStyle = COLORS[drawing.c];
    g.lineWidth = WIDTHS[drawing.w] * k;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(lastX * k, lastY * k);
    g.lineTo(x * k, y * k);
    g.stroke();
    lastX = x;
    lastY = y;
  });
  const endStroke = (e: PointerEvent) => {
    if (!drawing) return;
    e.preventDefault();
    const s = drawing;
    drawing = null;
    myStrokes.push(s);
    ctx.send({ type: "stroke", stroke: s });
    paintStrokes(canvas, myStrokes, canvasPx);
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  function buildTools() {
    toolsEl.innerHTML =
      COLORS.map(
        (c, i) =>
          `<button class="dc-swatch${i === color ? " on" : ""}" type="button" data-color="${i}" style="background:${c}" aria-label="colour ${i}"></button>`,
      ).join("") +
      WIDTHS.map(
        (_w, i) =>
          `<button class="dc-size${i === width ? " on" : ""}" type="button" data-width="${i}" aria-label="brush ${i + 1}"><span class="dc-dot" style="width:${6 + i * 6}px;height:${6 + i * 6}px"></span></button>`,
      ).join("") +
      `<button class="dc-tool" type="button" data-tool="undo">undo</button>`;
  }
  const onTool = (e: Event) => {
    const btn = (e.target as HTMLElement | null)?.closest?.("button") as
      | HTMLButtonElement
      | null;
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.color !== undefined) {
      color = Number(btn.dataset.color);
      toolsEl.querySelectorAll(".dc-swatch").forEach((el) =>
        el.classList.toggle("on", Number((el as HTMLElement).dataset.color) === color),
      );
    } else if (btn.dataset.width !== undefined) {
      width = Number(btn.dataset.width);
      toolsEl.querySelectorAll(".dc-size").forEach((el) =>
        el.classList.toggle("on", Number((el as HTMLElement).dataset.width) === width),
      );
    } else if (btn.dataset.tool === "undo") {
      if (!canDraw() || myStrokes.length === 0) return;
      myStrokes.pop();
      ctx.send({ type: "undo" });
      paintStrokes(canvas, myStrokes, canvasPx);
    }
  };
  toolsEl.addEventListener("touchstart", onTool, { passive: false });
  toolsEl.addEventListener("mousedown", onTool);

  // ─── actions (submit / done / host next / like) ─────────────────────────

  const onAction = (e: Event) => {
    const btn = (e.target as HTMLElement | null)?.closest?.("button[data-action]") as
      | HTMLButtonElement
      | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const a = btn.dataset.action;
    if (a === "done") {
      if (!canDraw()) return;
      submitted = true;
      ctx.send({ type: "done" });
      render();
    } else if (a === "submit") {
      submitText();
    } else if (a === "like" || a === "pass") {
      const c = Number(btn.dataset.chain);
      const s = Number(btn.dataset.step);
      const key = `${c}:${s}`;
      if (responded.has(key)) return;
      responded.set(key, a);
      if (a === "like") liked.add(key);
      ctx.send({ type: a, chain: c, step: s });
      viewKey = "";
      render();
    }
  };
  actionsEl.addEventListener("touchstart", onAction, { passive: false });
  actionsEl.addEventListener("mousedown", onAction);
  albumEl.addEventListener("touchstart", onAction, { passive: false });
  albumEl.addEventListener("mousedown", onAction);

  function submitText() {
    const input = formEl.querySelector<HTMLInputElement>("input");
    if (!input || submitted || !amParticipant) return;
    const text = input.value.trim();
    if (!text) return;
    submitted = true;
    ctx.send({ type: "text", text, final: true });
    input.disabled = true;
    input.blur();
    render();
  }

  // ─── views ──────────────────────────────────────────────────────────────

  function hideAll() {
    waitEl.hidden = true;
    canvasWrap.hidden = true;
    toolsEl.hidden = true;
    formEl.hidden = true;
    actionsEl.hidden = true;
    albumEl.hidden = true;
    resultsEl.hidden = true;
  }

  function buildTextView(t: TaskMsg) {
    // Guess: show the drawing you received above the input.
    if (t.kind === "guess" && t.input?.kind === "draw") {
      canvasWrap.hidden = false;
      // Keep the input high enough to stay visible above the keyboard.
      canvasPx = Math.min(300, fitCanvas(380));
      canvas.classList.remove("dc-drawable");
      paintStrokes(canvas, t.input.strokes, canvasPx);
    }
    formEl.hidden = false;
    formEl.innerHTML = `
      <input type="text" maxlength="40" autocomplete="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="done" placeholder="${t.kind === "prompt" ? "e.g. a cat on a skateboard" : "what is this?"}" ${amParticipant && !submitted ? "" : "disabled"} value="${escapeHtml(t.mine.text)}" />
    `;
    const input = formEl.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        if (!submitted) ctx.send({ type: "text", text: input.value, final: false });
      }, 250);
      const btn = actionsEl.querySelector<HTMLButtonElement>("[data-action='submit']");
      if (btn) btn.disabled = input.value.trim().length === 0;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitText();
      }
    });
    actionsEl.hidden = false;
    actionsEl.innerHTML = submitted
      ? `<button class="dc-btn" type="button" disabled>✓ SENT</button>`
      : `<button class="dc-btn" type="button" data-action="submit" ${t.mine.text.trim() ? "" : "disabled"}>${t.kind === "prompt" ? "SUBMIT" : "GUESS"}</button>`;
    if (t.kind === "prompt") {
      bannerEl.textContent = submitted ? "WAITING…" : "WRITE SOMETHING TO DRAW";
      subEl.textContent = "";
    } else {
      bannerEl.textContent = submitted ? "WAITING…" : "WHAT IS THIS?";
      subEl.textContent = `by ${nickOf(t.input?.by ?? null)}`;
    }
  }

  function buildDrawView(t: TaskMsg) {
    canvasWrap.hidden = false;
    toolsEl.hidden = !amParticipant || submitted;
    canvasPx = fitCanvas(submitted ? 230 : 270);
    canvas.classList.toggle("dc-drawable", canDraw());
    paintStrokes(canvas, myStrokes, canvasPx);
    if (toolsEl.childElementCount === 0) buildTools();
    actionsEl.hidden = !amParticipant;
    actionsEl.innerHTML = submitted
      ? `<button class="dc-btn" type="button" disabled>✓ DONE</button>`
      : `<button class="dc-btn" type="button" data-action="done">DONE</button>`;
    const text = t.input?.kind === "text" ? t.input.text : "?";
    bannerEl.textContent = submitted ? "WAITING…" : `draw: ${text}`;
    subEl.textContent = `from ${nickOf(t.input?.by ?? null)}`;
  }

  function buildAlbumView(st: StateMsg) {
    albumEl.hidden = false;
    const a = album;
    const pos = st.album;
    if (!a || !pos || a.chain !== pos.chain || a.step !== pos.step) {
      albumEl.innerHTML = `<div class="dc-wait">…</div>`;
      const now = Date.now();
      if (now - lastAlbumReqAt > 1000 && amParticipant) {
        lastAlbumReqAt = now;
        ctx.send({ type: "need-album" });
      }
      return;
    }
    const cur = a.entries[a.step];
    const prev = a.step > 0 ? a.entries[a.step - 1] : null;
    const original = a.entries[0]?.text ?? "";
    bannerEl.textContent = `${nickOf(a.startedBy)}'s chain`;
    subEl.textContent = `chain ${a.chain + 1}/${a.totalChains} · step ${a.step + 1}/${a.chainLength}`;

    const bigPx = fitCanvas(prev ? 330 : 260);
    const smallPx = 56;
    const prevHtml = prev
      ? `<div class="dc-album-prev">
          <span>${escapeHtml(nickOf(prev.playerId))} ${prev.kind === "draw" ? "drew" : prev.kind === "prompt" ? "wrote" : "guessed"}:</span>
          ${prev.kind === "draw" ? `<canvas id="dc-album-prev-canvas"></canvas>` : `<span class="dc-txt">${escapeHtml(prev.text)}</span>`}
        </div>`
      : "";
    const isMatch =
      cur.kind === "guess" &&
      !cur.auto &&
      cur.text.toLowerCase().replace(/\s+/g, " ").trim() ===
        original.toLowerCase().replace(/\s+/g, " ").trim();
    const curHtml =
      cur.kind === "draw"
        ? `<canvas id="dc-album-cur-canvas" class="dc-canvas"></canvas>`
        : `<div class="dc-album-text${cur.auto ? " dc-auto" : ""}${isMatch ? " dc-match" : ""}">${escapeHtml(cur.text)}${isMatch ? " ✓" : ""}</div>`;
    const key = `${a.chain}:${a.step}`;
    const likeCount = st.likes[key] ?? 0;
    const isArtist = cur.playerId === ctx.selfPlayerId;
    const heartable = cur.kind === "draw" || cur.kind === "guess";
    const canRespond = heartable && amParticipant && !isArtist;
    const loveLabel = cur.kind === "draw" ? "♥ love it" : "♥ good guess";
    const lovedLabel = cur.kind === "draw" ? "♥ loved it" : "♥ good guess";
    const mine = responded.get(key) ?? null;
    // Everyone but the artist answers; the step moves on when all have.
    const voters = st.connected.filter((id) => id !== cur.playerId).length;
    const answered = st.albumResponded.length;
    let likeHtml = "";
    if (heartable) {
      if (isArtist || !amParticipant) {
        likeHtml = `<span class="dc-like dc-liked">♥ ${likeCount}</span><span class="dc-resp">${answered}/${voters} answered</span>`;
      } else if (mine) {
        likeHtml = `<span class="dc-like${mine === "like" ? " dc-liked" : " dc-pass dc-picked"}">${mine === "like" ? lovedLabel : "no ♥"}</span><span class="dc-resp">♥ ${likeCount} · ${answered}/${voters} answered</span>`;
      } else {
        likeHtml = `<button class="dc-like" type="button" data-action="like" data-chain="${a.chain}" data-step="${a.step}" ${canRespond ? "" : "disabled"}>${loveLabel}</button><button class="dc-like dc-pass" type="button" data-action="pass" data-chain="${a.chain}" data-step="${a.step}" ${canRespond ? "" : "disabled"}>no ♥</button>`;
      }
    }
    const hostHtml = "";
    albumEl.innerHTML = `
      ${prevHtml}
      <div class="dc-album-cur">
        <div class="dc-album-by">${avatarOf(cur.playerId) ? `<img src="${avatarSrc(avatarOf(cur.playerId))}" alt="" />` : ""}<span>${escapeHtml(nickOf(cur.playerId))} ${cur.kind === "draw" ? "drew" : cur.kind === "prompt" ? "wrote" : "guessed"}${cur.playerId === ctx.selfPlayerId ? " (you)" : ""}</span></div>
        ${curHtml}
        <div class="dc-album-actions">${likeHtml}${hostHtml}</div>
      </div>
      ${cur.kind === "guess" && a.step > 1 ? `<div class="dc-note">started as: ${escapeHtml(original)}${isMatch ? " — still alive! +2" : ""}</div>` : ""}
    `;
    const pc = albumEl.querySelector<HTMLCanvasElement>("#dc-album-prev-canvas");
    if (pc && prev) paintStrokes(pc, prev.strokes, smallPx);
    const cc = albumEl.querySelector<HTMLCanvasElement>("#dc-album-cur-canvas");
    if (cc) paintStrokes(cc, cur.strokes, bigPx);
  }

  function buildResults(st: StateMsg) {
    resultsEl.hidden = false;
    if (resultsBuilt) return;
    resultsBuilt = true;
    const pts = st.points;
    const sorted = [...players].sort(
      (a, b) => (pts[b.playerId] ?? 0) - (pts[a.playerId] ?? 0),
    );
    const top = pts[sorted[0]?.playerId ?? ""] ?? 0;
    let rank = 0;
    let prev = -1;
    resultsEl.innerHTML =
      sorted
        .map((p, i) => {
          const v = pts[p.playerId] ?? 0;
          if (v !== prev) {
            rank = i + 1;
            prev = v;
          }
          const av = avatarOf(p.playerId);
          return `<div class="dc-res-row${v === top && top > 0 ? " dc-top" : ""}">
            <span class="dc-rank">${rank}.</span>
            ${av ? `<img src="${avatarSrc(av)}" alt="" />` : ""}
            <span class="dc-nm">${escapeHtml(p.nickname)}${p.playerId === ctx.selfPlayerId ? " (you)" : ""}</span>
            <span class="dc-p">${v} ♥</span>
          </div>`;
        })
        .join("") +
      `<div class="dc-note">♥ on your drawings and guesses · +2 for a guess that matched the original</div>`;
    bannerEl.textContent = "RESULTS";
    subEl.textContent = "";
  }

  // ─── render ─────────────────────────────────────────────────────────────

  function refreshCountdown() {
    const st = currentState;
    if (!st) return;
    const working = st.phase === "prompt" || st.phase === "draw" || st.phase === "guess";
    if (working || st.phase === "album") {
      const s = secs(st.phaseEndsAt);
      countEl.textContent = st.phase === "album" ? "" : String(s);
      countEl.classList.toggle("dc-hurry", working && s <= 10);
    } else {
      countEl.textContent = "";
    }
  }
  const countdownTimer = setInterval(refreshCountdown, 250);

  function render() {
    const st = currentState;
    if (!st) return;
    const working = st.phase === "prompt" || st.phase === "draw" || st.phase === "guess";

    statusEl.textContent = statusLine(
      "doodle chain",
      working
        ? `step ${st.stepIndex + 1}/${st.chainLength} · ${st.doneIds.length}/${st.connected.length} done`
        : st.phase === "album"
          ? "the album"
          : "results",
    );
    if (amParticipant) {
      ctx.setMatchScore(
        st.phase === "album" || st.phase === "results" || st.phase === "ended"
          ? `you: ${st.points[ctx.selfPlayerId] ?? 0} ♥`
          : `step ${st.stepIndex + 1}/${st.chainLength}`,
      );
    } else {
      ctx.setMatchScore(null);
    }
    refreshCountdown();

    if (working) {
      const haveTask = task && task.stepIndex === st.stepIndex;
      if (!haveTask && amParticipant) {
        // Ask (throttled) on every state tick until the task arrives —
        // covers reconnects and a request that raced the warm-up.
        const now = Date.now();
        if (now - lastTaskReqAt > 1000) {
          lastTaskReqAt = now;
          ctx.send({ type: "need-task" });
        }
      }
      const key = `${st.phase}:${st.stepIndex}:${haveTask}:${submitted}:${amParticipant}`;
      if (key === viewKey) return;
      viewKey = key;
      hideAll();
      if (!amParticipant) {
        waitEl.hidden = false;
        waitEl.textContent =
          st.phase === "prompt" ? "players are writing prompts…" : st.phase === "draw" ? "players are drawing…" : "players are guessing…";
        bannerEl.textContent = "DOODLE CHAIN";
        subEl.textContent = "spectating";
        return;
      }
      if (!haveTask) {
        waitEl.hidden = false;
        waitEl.textContent = "…";
        return;
      }
      if (task!.kind === "draw") buildDrawView(task!);
      else buildTextView(task!);
      return;
    }

    if (st.phase === "album") {
      (document.activeElement as HTMLElement | null)?.blur?.();
      const ak = `${st.album?.chain}:${st.album?.step}`;
      const key = `album:${ak}:${album?.chain}:${album?.step}:${st.likes[ak] ?? 0}:${st.albumResponded.length}:${responded.get(ak) ?? ""}`;
      if (key === viewKey) return;
      viewKey = key;
      hideAll();
      buildAlbumView(st);
      return;
    }

    if (st.phase === "results" || st.phase === "ended") {
      if (viewKey !== "results") {
        viewKey = "results";
        hideAll();
      }
      buildResults(st);
      if (!flashed) {
        flashed = true;
        flash.flash(amParticipant ? `${st.points[ctx.selfPlayerId] ?? 0} ♥` : "RESULTS");
      }
    }
  }

  function applyTask(t: TaskMsg) {
    if (ctx.isSpectator) return;
    const fresh = !task || task.stepIndex !== t.stepIndex;
    task = t;
    if (fresh) {
      submitted = t.mine.done;
      myStrokes = t.kind === "draw" ? [...t.mine.strokes] : [];
      color = 0;
      width = 1;
      toolsEl.innerHTML = "";
      viewKey = "";
    }
    render();
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") {
        const st = msg as unknown as StateMsg;
        const prevPhase = currentState?.phase;
        const prevStep = currentState?.stepIndex;
        currentState = st;
        if (prevPhase !== st.phase || prevStep !== st.stepIndex) viewKey = "";
        render();
      } else if (msg.type === "task") applyTask(msg as unknown as TaskMsg);
      else if (msg.type === "album") {
        album = msg as unknown as AlbumMsg;
        viewKey = "";
        render();
      }
    },
    unmount() {
      clearInterval(countdownTimer);
      if (sendTimer) clearTimeout(sendTimer);
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

const DoodleChainClient: MiniGameClientDefinition = {
  id: "doodle-chain",
  controlsHint:
    "write a prompt → the next player draws it → the next guesses → the next draws that… then the album: ♥ (or no ♥) every drawing and guess",
  createMatch: createDoodleChainMatchClient,
};

registerMiniGameClient(DoodleChainClient);

export default DoodleChainClient;
