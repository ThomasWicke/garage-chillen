// Who Am I? client (curated + custom share this module). Pure DOM.
//
//   write   (custom) — "write an identity for <name>" + one input + GIVE
//   play             — big "YOU: ???" card (+ NEXT PLAYER when it's your
//                      turn), then a tile per OTHER player showing their
//                      identity and a ✓ GOT IT button. When
//                      someone says their guess and the room says yes,
//                      anyone else taps ✓ on their tile (tap again = undo).
//   results          — everyone's identity + who guessed in which order.
//
// Identities arrive per-player in `board` messages (re-sent every second),
// so a reconnecting phone rebuilds its view; your own identity is only in
// there once it's public.

import { avatarSrc } from "../../identity";
import { statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "write" | "play" | "results" | "ended";

type WelcomeMsg = {
  type: "welcome";
  deadlineAt: number;
  startAt: number;
  custom: boolean;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  phaseEndsAt: number;
  deadlineAt: number;
  custom: boolean;
  writtenIds: string[];
  solvedOrder: string[];
  /** Whose turn it is to ask a question (play phase). */
  turnId: string | null;
  lastOneId: string | null;
  connected: string[];
  revealed: Record<string, string> | null;
  writers: Record<string, string> | null;
};

type BoardMsg = {
  type: "board";
  phase: Phase;
  others: Record<string, string>;
  mine: string | null;
  writeFor: string | null;
  writeForNick: string | null;
  written: string;
  submitted: boolean;
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function fmt(at: number): string {
  const s = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function createWhoAmIMatchClient(
  custom: boolean,
  ctx: MatchClientContext,
): MatchClientSession {
  void custom; // both variants render identically; the server drives the write phase
  ctx.container.innerHTML = `
    <div class="wai-root" id="wai-root">
      <style>
        .wai-root {
          position: relative;
          box-sizing: border-box;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
          padding: 10px 12px 14px;
          background: #0a0a14;
          color: #f2f2f5;
          overflow: hidden;
          text-align: center;
        }
        .wai-root [hidden] { display: none !important; }
        .wai-status { font-size: 13px; color: #9a9aa5; }
        .wai-banner {
          font-size: clamp(18px, 6vw, 26px);
          font-weight: 800;
          color: #abdd64;
          line-height: 1.15;
        }
        .wai-sub { font-size: 13px; color: #9a9aa5; min-height: 1.2em; }

        .wai-me {
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 14px;
          padding: 8px 10px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .wai-me img { width: 40px; height: 40px; border-radius: 9px; }
        .wai-me-txt { flex: 1; text-align: left; min-width: 0; }
        .wai-me-lbl { font-size: 11px; color: #9a9aa5; }
        .wai-me-id {
          font-size: clamp(18px, 6vw, 24px);
          font-weight: 800;
          color: #f2f2f5;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .wai-me.wai-solved { border-color: #abdd64; }
        .wai-me.wai-turn { border-color: #ffd05d; box-shadow: 0 0 16px rgba(255, 208, 93, 0.35); }
        .wai-turn-btn {
          font-family: inherit;
          font-size: 16px;
          font-weight: 800;
          padding: 12px 16px;
          border-radius: 12px;
          border: 3px solid #ffd05d;
          background: #ffd05d;
          color: #0a0a14;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .wai-tile.wai-asking { border-color: #ffd05d; }
        .wai-tile-turn { font-size: 11px; color: #ffd05d; font-weight: 700; }
        .wai-me.wai-solved .wai-me-id { color: #abdd64; }
        .wai-clock {
          font-size: clamp(20px, 7vw, 30px);
          font-weight: 800;
          font-variant-numeric: tabular-nums;
        }
        .wai-clock.wai-hurry { color: #e0596a; }

        .wai-form { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
        .wai-form input {
          font-family: inherit;
          font-size: 20px;
          padding: 12px 14px;
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
        .wai-form input:focus { border-color: #abdd64; }
        .wai-btn {
          font-family: inherit;
          font-size: 18px;
          font-weight: 800;
          padding: 12px 18px;
          border-radius: 12px;
          border: 3px solid #abdd64;
          background: #abdd64;
          color: #0a0a14;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .wai-btn:disabled { opacity: 0.35; }
        .wai-form-target { font-size: 15px; }
        .wai-form-target b { color: #ffd05d; }
        .wai-written { font-size: 12px; color: #9a9aa5; }

        .wai-grid {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 8px;
          align-content: start;
          padding-bottom: 6px;
        }
        .wai-tile {
          background: #14141f;
          border: 2px solid #2a2a3a;
          border-radius: 12px;
          padding: 8px 8px 8px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          min-width: 0;
        }
        .wai-tile-head { display: flex; align-items: center; gap: 6px; max-width: 100%; }
        .wai-tile-head img { width: 24px; height: 24px; border-radius: 6px; }
        .wai-tile-nick { font-size: 12px; color: #9a9aa5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wai-tile-id {
          font-size: 16px;
          font-weight: 800;
          line-height: 1.15;
          overflow-wrap: anywhere;
        }
        .wai-tile.wai-done { border-color: #abdd64; }
        .wai-tile.wai-done .wai-tile-id { color: #abdd64; }
        .wai-tile.wai-gone { opacity: 0.4; }
        .wai-tile-btn {
          font-family: inherit;
          font-size: 13px;
          font-weight: 800;
          padding: 7px 10px;
          border-radius: 9px;
          border: 2px solid #abdd64;
          background: transparent;
          color: #abdd64;
          width: 100%;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .wai-tile.wai-done .wai-tile-btn { border-color: #2a2a3a; color: #9a9aa5; }
        .wai-tile-btn:disabled { opacity: 0.35; }

        .wai-results {
          flex: 0 1 auto;
          min-height: 0;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          width: min(380px, 100%);
          margin: 0 auto;
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 16px;
          padding: 10px;
          animation: wai-pop 0.35s ease-out;
        }
        @keyframes wai-pop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .wai-res-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          text-align: left;
        }
        .wai-res-row img { width: 28px; height: 28px; border-radius: 7px; }
        .wai-res-row .wai-rank { width: 2.2em; color: #abdd64; font-weight: 800; font-variant-numeric: tabular-nums; }
        .wai-res-row .wai-rank.wai-none { color: #9a9aa5; font-weight: 400; }
        .wai-res-row .wai-nm { color: #9a9aa5; font-size: 12px; }
        .wai-res-row .wai-txt { flex: 1; min-width: 0; }
        .wai-res-row .wai-id { font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wai-res-row .wai-by { font-size: 11px; color: #9a9aa5; }
        .wai-note { font-size: 11px; color: #9a9aa5; }
      </style>
      <div class="wai-status" id="wai-status"></div>
      <div class="wai-banner" id="wai-banner"></div>
      <div class="wai-sub" id="wai-sub"></div>
      <div class="wai-form" id="wai-form" hidden></div>
      <div class="wai-me" id="wai-me" hidden></div>
      <div id="wai-turn" hidden><button class="wai-turn-btn" type="button" data-action="next-turn">NEXT PLAYER ▸</button></div>
      <div class="wai-grid" id="wai-grid" hidden></div>
      <div class="wai-results" id="wai-results" hidden></div>
    </div>
  `;
  const $ = <T extends HTMLElement>(id: string) =>
    ctx.container.querySelector<T>(`#${id}`)!;
  const rootEl = $("wai-root");
  const statusEl = $("wai-status");
  const bannerEl = $("wai-banner");
  const subEl = $("wai-sub");
  const formEl = $("wai-form");
  const meEl = $("wai-me");
  const turnEl = $("wai-turn");
  const gridEl = $("wai-grid");
  const resultsEl = $("wai-results");
  const flash = createMatchFlash(rootEl);

  let players: WelcomeMsg["players"] = [];
  let amParticipant = false;
  let built = false;
  let currentState: StateMsg | null = null;
  let board: BoardMsg | null = null;
  let formBuilt = false;
  let submitted = false;
  let gridSig = "";
  let meSig = "";
  let resultsBuilt = false;
  let flashed = false;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;

  const self = () => players.find((p) => p.playerId === ctx.selfPlayerId);
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
    if (built) return;
    built = true;
    bannerEl.textContent = "WHO AM I?";
    subEl.textContent = "";
  }

  // ─── write (custom) ─────────────────────────────────────────────────────

  function buildForm() {
    if (formBuilt) return;
    formBuilt = true;
    formEl.innerHTML = `
      <div class="wai-form-target" id="wai-form-target"></div>
      <input type="text" id="wai-input" maxlength="30" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done" placeholder="a person, character, thing…" ${amParticipant ? "" : "disabled"} />
      <button class="wai-btn" type="button" data-action="give" disabled>GIVE</button>
      <div class="wai-written" id="wai-written"></div>
    `;
    const input = formEl.querySelector<HTMLInputElement>("#wai-input")!;
    const btn = formEl.querySelector<HTMLButtonElement>("[data-action='give']")!;
    input.addEventListener("input", () => {
      btn.disabled = input.value.trim().length === 0 || submitted;
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        if (!submitted) ctx.send({ type: "identity", text: input.value, final: false });
      }, 250);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        give();
      }
    });
    const give = () => {
      if (submitted || !amParticipant) return;
      const text = input.value.trim();
      if (!text) return;
      submitted = true;
      ctx.send({ type: "identity", text, final: true });
      input.disabled = true;
      btn.disabled = true;
      btn.textContent = "✓ GIVEN";
      input.blur();
    };
    const onGive = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[data-action='give']")) return;
      e.preventDefault();
      give();
    };
    btn.addEventListener("touchstart", onGive, { passive: false });
    btn.addEventListener("mousedown", onGive);
  }

  function updateForm(st: StateMsg) {
    const target = formEl.querySelector<HTMLElement>("#wai-form-target");
    const writtenEl = formEl.querySelector<HTMLElement>("#wai-written");
    if (target) {
      target.innerHTML = amParticipant
        ? `write an identity for <b>${escapeHtml(board?.writeForNick ?? "…")}</b>`
        : "players are writing identities for each other…";
    }
    if (writtenEl) {
      writtenEl.textContent = `${st.writtenIds.length}/${st.connected.length} given`;
    }
    if (board?.submitted && !submitted) {
      submitted = true;
      const input = formEl.querySelector<HTMLInputElement>("#wai-input");
      const btn = formEl.querySelector<HTMLButtonElement>("[data-action='give']");
      if (input) {
        input.value = board.written;
        input.disabled = true;
      }
      if (btn) {
        btn.disabled = true;
        btn.textContent = "✓ GIVEN";
      }
    }
  }

  // ─── play ───────────────────────────────────────────────────────────────

  function buildMe(st: StateMsg) {
    const me = self();
    const rank = st.solvedOrder.indexOf(ctx.selfPlayerId);
    const solved = rank !== -1;
    const mine = board?.mine ?? null;
    const myTurn = amParticipant && st.turnId === ctx.selfPlayerId;
    const sig = `${solved}:${mine}:${st.phase}:${amParticipant}:${myTurn}`;
    if (sig === meSig) return;
    meSig = sig;
    meEl.classList.toggle("wai-solved", solved);
    meEl.classList.toggle("wai-turn", myTurn);
    turnEl.hidden = !myTurn;
    if (!amParticipant) {
      meEl.innerHTML = `<div class="wai-me-txt"><div class="wai-me-lbl">spectating</div><div class="wai-me-id">…</div></div>`;
      return;
    }
    meEl.innerHTML = `
      ${me ? `<img src="${avatarSrc(me.avatarId)}" alt="" />` : ""}
      <div class="wai-me-txt">
        <div class="wai-me-lbl">${solved ? `you got it · #${rank + 1}` : "you are…"}</div>
        <div class="wai-me-id">${solved && mine ? escapeHtml(mine) : "???"}</div>
      </div>
      <div class="wai-clock" id="wai-clock"></div>
    `;
  }

  function buildGrid(st: StateMsg) {
    const others = players.filter((p) => p.playerId !== ctx.selfPlayerId);
    const conn = new Set(st.connected);
    const sig = JSON.stringify([
      others.map((p) => p.playerId),
      st.solvedOrder,
      st.connected,
      board?.others ?? {},
      amParticipant,
      st.turnId,
    ]);
    if (sig === gridSig) return;
    gridSig = sig;
    gridEl.innerHTML = others
      .map((p) => {
        const idText = board?.others?.[p.playerId] ?? null;
        const rank = st.solvedOrder.indexOf(p.playerId);
        const done = rank !== -1;
        const gone = !conn.has(p.playerId);
        const asking = st.turnId === p.playerId;
        return `<div class="wai-tile${done ? " wai-done" : ""}${gone ? " wai-gone" : ""}${asking ? " wai-asking" : ""}" data-pid="${escapeHtml(p.playerId)}">
          <div class="wai-tile-head">
            <img src="${avatarSrc(p.avatarId)}" alt="" />
            <span class="wai-tile-nick">${escapeHtml(p.nickname)}${gone ? " · left" : ""}</span>
          </div>
          ${asking ? `<div class="wai-tile-turn">asking now</div>` : ""}
          <div class="wai-tile-id">${idText ? escapeHtml(idText) : "…"}</div>
          ${
            amParticipant
              ? `<button class="wai-tile-btn" type="button" data-action="${done ? "unsolve" : "solved"}" data-pid="${escapeHtml(p.playerId)}" ${gone && !done ? "disabled" : ""}>${done ? `got it #${rank + 1} · undo` : "✓ GOT IT"}</button>`
              : done
                ? `<div class="wai-note">got it #${rank + 1}</div>`
                : ""
          }
        </div>`;
      })
      .join("");
  }

  let lastTapAt = 0;
  const onTileTap = (e: Event) => {
    const st = currentState;
    if (!st || st.phase !== "play" || !amParticipant) return;
    const btn = (e.target as HTMLElement | null)?.closest?.(
      "button[data-action]",
    ) as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastTapAt < 300) return;
    lastTapAt = now;
    const pid = btn.dataset.pid!;
    const action = btn.dataset.action;
    if (action !== "solved" && action !== "unsolve") return;
    ctx.send({ type: action, playerId: pid });
  };
  gridEl.addEventListener("touchstart", onTileTap, { passive: false });
  gridEl.addEventListener("mousedown", onTileTap);

  let lastTurnTapAt = 0;
  const onTurnTap = (e: Event) => {
    const st = currentState;
    if (!st || st.phase !== "play" || st.turnId !== ctx.selfPlayerId) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastTurnTapAt < 400) return;
    lastTurnTapAt = now;
    ctx.send({ type: "next-turn" });
  };
  turnEl.addEventListener("touchstart", onTurnTap, { passive: false });
  turnEl.addEventListener("mousedown", onTurnTap);

  // ─── results ────────────────────────────────────────────────────────────

  function buildResults(st: StateMsg) {
    if (resultsBuilt || !st.revealed) return;
    resultsBuilt = true;
    const order = [
      ...st.solvedOrder,
      ...players.map((p) => p.playerId).filter((id) => !st.solvedOrder.includes(id)),
    ];
    resultsEl.innerHTML =
      order
        .map((pid) => {
          const rank = st.solvedOrder.indexOf(pid);
          const av = avatarOf(pid);
          const writer = st.writers?.[pid];
          return `<div class="wai-res-row">
            <span class="wai-rank${rank === -1 ? " wai-none" : ""}">${rank === -1 ? "—" : `#${rank + 1}`}</span>
            ${av ? `<img src="${avatarSrc(av)}" alt="" />` : ""}
            <span class="wai-txt">
              <div class="wai-id">${escapeHtml(st.revealed?.[pid] ?? "?")}</div>
              <div class="wai-by">${escapeHtml(nickOf(pid))}${pid === ctx.selfPlayerId ? " (you)" : ""}${writer ? ` · by ${escapeHtml(nickOf(writer))}` : ""}</div>
            </span>
          </div>`;
        })
        .join("") +
      `<div class="wai-note">${st.solvedOrder.length}/${players.length} guessed</div>`;
  }

  // ─── state ──────────────────────────────────────────────────────────────

  function refreshClock() {
    const st = currentState;
    if (!st) return;
    const clockEl = meEl.querySelector<HTMLElement>("#wai-clock");
    if (clockEl && st.phase === "play") {
      clockEl.textContent = fmt(st.phaseEndsAt);
      clockEl.classList.toggle(
        "wai-hurry",
        st.phaseEndsAt - Date.now() <= 30_000,
      );
    }
    if (st.phase === "write") {
      const s = Math.max(0, Math.ceil((st.phaseEndsAt - Date.now()) / 1000));
      statusEl.textContent = statusLine("who am i?", "writing", `${s}s`);
    }
  }
  const clockTimer = setInterval(refreshClock, 250);

  function render() {
    const st = currentState;
    if (!st) return;
    const write = st.phase === "write";
    const play = st.phase === "play";
    const results = st.phase === "results" || st.phase === "ended";

    formEl.hidden = !write;
    meEl.hidden = !play;
    if (!play) turnEl.hidden = true;
    gridEl.hidden = !play;
    resultsEl.hidden = !results;

    if (amParticipant) {
      const rank = st.solvedOrder.indexOf(ctx.selfPlayerId);
      ctx.setMatchScore(
        write
          ? "writing…"
          : rank !== -1
            ? `you: #${rank + 1}`
            : `${st.solvedOrder.length}/${players.length} solved`,
      );
    } else {
      ctx.setMatchScore(null);
    }

    if (write) {
      buildForm();
      updateForm(st);
      bannerEl.textContent = submitted ? "WAITING…" : "GIVE AN IDENTITY";
      subEl.textContent = "";
      refreshClock();
    } else if (play) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      buildMe(st);
      buildGrid(st);
      refreshClock();
      statusEl.textContent = statusLine(
        "who am i?",
        `${st.solvedOrder.length}/${players.length} solved`,
      );
      const meSolved = st.solvedOrder.includes(ctx.selfPlayerId);
      const myTurn = amParticipant && st.turnId === ctx.selfPlayerId;
      bannerEl.textContent = !amParticipant
        ? "THE ROOM IS GUESSING"
        : meSolved
          ? `SOLVED #${st.solvedOrder.indexOf(ctx.selfPlayerId) + 1}`
          : myTurn
            ? "YOUR TURN — ASK A YES/NO QUESTION"
            : st.turnId
              ? `${nickOf(st.turnId).toUpperCase()} IS ASKING`
              : "ASK YES/NO QUESTIONS";
      subEl.textContent = st.lastOneId
        ? `${st.lastOneId === ctx.selfPlayerId ? "you're" : nickOf(st.lastOneId) + " is"} the last one — 30s!`
        : "";
    } else if (results) {
      buildResults(st);
      statusEl.textContent = statusLine("who am i?", "results");
      bannerEl.textContent = "THE REVEAL";
      const rank = st.solvedOrder.indexOf(ctx.selfPlayerId);
      subEl.textContent = amParticipant
        ? rank !== -1
          ? `you were ${st.revealed?.[ctx.selfPlayerId] ?? "?"} — guessed #${rank + 1}`
          : `you were ${st.revealed?.[ctx.selfPlayerId] ?? "?"}`
        : "";
      if (!flashed) {
        flashed = true;
        flash.flash(
          amParticipant && rank !== -1 ? `#${rank + 1}!` : "THE REVEAL",
        );
      }
    }
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") {
        currentState = msg as unknown as StateMsg;
        render();
      } else if (msg.type === "board") {
        if (ctx.isSpectator) return;
        board = msg as unknown as BoardMsg;
        // Board changes what the tiles say — force a re-render.
        render();
      }
    },
    unmount() {
      clearInterval(clockTimer);
      if (sendTimer) clearTimeout(sendTimer);
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

registerMiniGameClient({
  id: "who-am-i",
  controlsHint:
    "everyone else can see who you are — take turns asking yes/no questions out loud (NEXT PLAYER passes the turn); when you get it, the room taps ✓ on your tile",
  createMatch: (ctx) => createWhoAmIMatchClient(false, ctx),
} satisfies MiniGameClientDefinition);

registerMiniGameClient({
  id: "who-am-i-custom",
  controlsHint:
    "first write an identity for the player next to you — then take turns asking yes/no questions out loud; when you get it, the room taps ✓ on your tile",
  createMatch: (ctx) => createWhoAmIMatchClient(true, ctx),
} satisfies MiniGameClientDefinition);
