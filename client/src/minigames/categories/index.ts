// Categories client. Pure DOM (text inputs — no kaplay).
//
//   write   — letter + 4 category inputs; STOP once all four are filled
//             (the first STOP gives everyone else 10s). Answers are sent as
//             you type (debounced) so a hard phase end never loses text.
//   review  — the whole grid, grouped by category. Tap any answer to strike
//             it (tap again to restore) — the room decides out loud, the
//             phone records it. Host has END REVIEW.
//   results — points + placements.
//
// The server never shows other people's answers before review, so this
// screen has nothing to hide during write.

import { avatarSrc } from "../../identity";
import { statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "write" | "review" | "results" | "ended";
type CellStatus = "ok" | "dup" | "empty" | "invalid" | "struck";
type Cell = { text: string; status: CellStatus; pts: number };

type WelcomeMsg = {
  type: "welcome";
  deadlineAt: number;
  startAt: number;
  letter: string;
  categories: string[];
  scoring: { unique: number; dup: number };
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  phaseEndsAt: number;
  deadlineAt: number;
  letter: string;
  categories: string[];
  doneIds: string[];
  stopperId: string | null;
  connected: string[];
  grid: Record<string, Cell[]> | null;
  points: Record<string, number> | null;
};

const SEND_DEBOUNCE_MS = 200;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function secsLeft(at: number): number {
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function createCategoriesMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="cat-root" id="cat-root">
      <style>
        .cat-root {
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
        }
        .cat-root [hidden] { display: none !important; }
        .cat-status { font-size: 13px; color: #9a9aa5; text-align: center; }
        .cat-head {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 14px;
        }
        .cat-letter {
          font-size: clamp(34px, 12vw, 56px);
          font-weight: 800;
          color: #abdd64;
          line-height: 1;
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 14px;
          padding: 6px 16px;
          min-width: 1.6em;
          text-align: center;
        }
        .cat-head-txt { text-align: left; }
        .cat-banner {
          font-size: clamp(17px, 5.5vw, 24px);
          font-weight: 800;
          color: #f2f2f5;
          line-height: 1.15;
        }
        .cat-sub { font-size: 13px; color: #9a9aa5; min-height: 1.2em; }
        .cat-count {
          font-size: clamp(22px, 8vw, 34px);
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          color: #f2f2f5;
          margin-left: auto;
        }
        .cat-count.cat-hurry { color: #e0596a; }

        /* write */
        .cat-form { display: flex; flex-direction: column; gap: 8px; }
        .cat-row { display: flex; flex-direction: column; gap: 2px; }
        .cat-label { font-size: 12px; color: #9a9aa5; padding-left: 4px; }
        .cat-row input {
          font-family: inherit;
          font-size: 18px;
          padding: 10px 12px;
          background: #14141f;
          color: #f2f2f5;
          border: 2px solid #2a2a3a;
          border-radius: 10px;
          outline: none;
          width: 100%;
          -webkit-user-select: text;
          user-select: text;
          touch-action: manipulation;
        }
        .cat-row input:focus { border-color: #abdd64; }
        .cat-row input.cat-bad { border-color: #e0596a; }
        .cat-row input:disabled { opacity: 0.6; }
        .cat-btn {
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
        .cat-btn:disabled { opacity: 0.35; }
        .cat-btn.cat-ghost { background: transparent; color: #abdd64; }
        .cat-btn.cat-done { background: #14141f; color: #abdd64; }
        .cat-actions { display: flex; gap: 8px; justify-content: center; align-items: center; }
        .cat-doneline { font-size: 12px; color: #9a9aa5; text-align: center; }

        /* review */
        .cat-review {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-bottom: 6px;
        }
        .cat-cat {
          background: #14141f;
          border: 2px solid #2a2a3a;
          border-radius: 12px;
          padding: 6px 8px 8px;
        }
        .cat-cat-name {
          font-size: 12px;
          color: #abdd64;
          font-weight: 700;
          margin-bottom: 4px;
        }
        .cat-chips { display: flex; flex-wrap: wrap; gap: 5px; }
        .cat-chip {
          display: inline-flex;
          align-items: baseline;
          gap: 5px;
          background: #1e1e2c;
          border: 2px solid transparent;
          border-radius: 8px;
          padding: 4px 8px;
          font-size: 14px;
          line-height: 1.2;
          max-width: 100%;
          -webkit-tap-highlight-color: transparent;
        }
        .cat-chip.cat-tappable { cursor: pointer; }
        .cat-chip .cat-nick { font-size: 10px; color: #9a9aa5; white-space: nowrap; }
        .cat-chip .cat-ans {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 40vw;
        }
        .cat-chip .cat-pts { font-size: 11px; font-weight: 800; color: #abdd64; white-space: nowrap; }
        .cat-chip.cat-dup .cat-pts { color: #ffd05d; }
        .cat-chip.cat-struck .cat-ans { text-decoration: line-through; color: #9a9aa5; }
        .cat-chip.cat-struck { border-color: #e0596a; }
        .cat-chip.cat-struck .cat-pts, .cat-chip.cat-invalid .cat-pts, .cat-chip.cat-empty .cat-pts { color: #e0596a; }
        .cat-chip.cat-invalid .cat-ans { color: #e0596a; text-decoration: line-through; }
        .cat-chip.cat-empty .cat-ans { color: #9a9aa5; }
        .cat-chip.cat-me { border-color: #2a2a3a; }
        .cat-chip.cat-me.cat-struck { border-color: #e0596a; }
        .cat-scores {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 4px 6px;
          font-size: 12px;
        }
        .cat-score {
          background: #1e1e2c;
          border-radius: 6px;
          padding: 3px 7px;
          white-space: nowrap;
        }
        .cat-score.cat-me { outline: 1px solid #abdd64; }
        .cat-score b { color: #abdd64; }

        /* results */
        .cat-results {
          display: flex;
          flex-direction: column;
          gap: 6px;
          width: min(360px, 94%);
          margin: 0 auto;
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 16px;
          padding: 12px 10px;
          animation: cat-pop 0.35s ease-out;
        }
        @keyframes cat-pop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .cat-res-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 15px;
        }
        .cat-res-row img { width: 30px; height: 30px; border-radius: 7px; }
        .cat-res-row .cat-rank { width: 1.6em; color: #9a9aa5; font-variant-numeric: tabular-nums; }
        .cat-res-row .cat-nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
        .cat-res-row .cat-p { font-weight: 800; color: #abdd64; }
        .cat-res-row.cat-top .cat-nm { color: #ffd05d; font-weight: 700; }
        .cat-note { font-size: 11px; color: #9a9aa5; text-align: center; }
      </style>
      <div class="cat-status" id="cat-status"></div>
      <div class="cat-head">
        <div class="cat-letter" id="cat-letter">?</div>
        <div class="cat-head-txt">
          <div class="cat-banner" id="cat-banner"></div>
          <div class="cat-sub" id="cat-sub"></div>
        </div>
        <div class="cat-count" id="cat-count"></div>
      </div>
      <div class="cat-form" id="cat-form" hidden></div>
      <div class="cat-actions" id="cat-actions" hidden></div>
      <div class="cat-doneline" id="cat-doneline" hidden></div>
      <div class="cat-review" id="cat-review" hidden></div>
      <div class="cat-scores" id="cat-scores" hidden></div>
      <div class="cat-results" id="cat-results" hidden></div>
    </div>
  `;
  const $ = <T extends HTMLElement>(id: string) =>
    ctx.container.querySelector<T>(`#${id}`)!;
  const rootEl = $("cat-root");
  const statusEl = $("cat-status");
  const letterEl = $("cat-letter");
  const bannerEl = $("cat-banner");
  const subEl = $("cat-sub");
  const countEl = $("cat-count");
  const formEl = $("cat-form");
  const actionsEl = $("cat-actions");
  const doneLineEl = $("cat-doneline");
  const reviewEl = $("cat-review");
  const scoresEl = $("cat-scores");
  const resultsEl = $("cat-results");
  const flash = createMatchFlash(rootEl);

  let players: WelcomeMsg["players"] = [];
  let scoring = { unique: 10, dup: 5 };
  let amParticipant = false;
  let built = false;
  let categories: string[] = [];
  let letter = "";
  let currentState: StateMsg | null = null;
  let formBuilt = false;
  let actionsBuiltFor = "";
  let iAmDone = false;
  let flashedResults = false;
  let resultsBuilt = false;
  /** Signature of the last rendered review grid, to skip no-op rebuilds
   *  (rebuilding while a finger is on a chip would eat the tap). */
  let reviewSig = "";
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDoneResendAt = 0;

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }
  function avatarOf(pid: string): string {
    return players.find((p) => p.playerId === pid)?.avatarId ?? "";
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    if (msg.scoring) scoring = msg.scoring;
    categories = msg.categories;
    letter = msg.letter;
    amParticipant =
      !ctx.isSpectator && players.some((p) => p.playerId === ctx.selfPlayerId);
    if (built) return;
    built = true;
    letterEl.textContent = letter;
    bannerEl.textContent = "CATEGORIES";
    subEl.textContent = "";
  }

  // ─── write phase ────────────────────────────────────────────────────────

  function readAnswers(): string[] {
    return categories.map((_, i) => {
      const inp = formEl.querySelector<HTMLInputElement>(`input[data-ci="${i}"]`);
      return inp ? inp.value : "";
    });
  }

  function allFilled(): boolean {
    return readAnswers().every((a) => a.trim().length > 0);
  }

  function sendAnswersNow() {
    if (sendTimer) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    if (!amParticipant) return;
    ctx.send({ type: "answers", answers: readAnswers() });
  }

  function queueSend() {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(sendAnswersNow, SEND_DEBOUNCE_MS);
  }

  function markLetterHints() {
    const l = letter.toLowerCase();
    formEl.querySelectorAll<HTMLInputElement>("input").forEach((inp) => {
      const v = inp.value.trim().toLowerCase();
      inp.classList.toggle("cat-bad", v.length > 0 && !v.startsWith(l));
    });
  }

  function buildForm() {
    if (formBuilt) return;
    formBuilt = true;
    formEl.innerHTML = categories
      .map(
        (c, i) => `<label class="cat-row">
          <span class="cat-label">${escapeHtml(c)}</span>
          <input type="text" data-ci="${i}" maxlength="24" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="${i === categories.length - 1 ? "done" : "next"}" placeholder="${escapeHtml(letter)}…" ${amParticipant ? "" : "disabled"} />
        </label>`,
      )
      .join("");
    formEl.querySelectorAll<HTMLInputElement>("input").forEach((inp, i) => {
      inp.addEventListener("input", () => {
        markLetterHints();
        queueSend();
        updateActions();
      });
      inp.addEventListener("blur", sendAnswersNow);
      inp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        sendAnswersNow();
        const next = formEl.querySelector<HTMLInputElement>(
          `input[data-ci="${i + 1}"]`,
        );
        if (next) next.focus();
        else inp.blur();
      });
    });
  }

  function updateActions() {
    const st = currentState;
    if (!st || st.phase !== "write") return;
    if (!amParticipant) {
      actionsEl.hidden = true;
      return;
    }
    const canStop = allFilled() && !iAmDone;
    const key = `${iAmDone}:${canStop}`;
    actionsEl.hidden = false;
    if (key !== actionsBuiltFor) {
      actionsBuiltFor = key;
      actionsEl.innerHTML = iAmDone
        ? `<button class="cat-btn cat-done" type="button" disabled>✓ DONE</button>`
        : `<button class="cat-btn" type="button" data-action="stop" ${canStop ? "" : "disabled"}>STOP!</button>`;
    }
  }

  const onStop = (e: Event) => {
    const btn = (e.target as HTMLElement | null)?.closest?.(
      "[data-action='stop']",
    );
    if (!btn || iAmDone) return;
    if (!allFilled()) return;
    e.preventDefault();
    sendAnswersNow();
    ctx.send({ type: "done" });
    iAmDone = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    updateActions();
  };
  actionsEl.addEventListener("touchstart", onStop, { passive: false });
  actionsEl.addEventListener("mousedown", onStop);

  // ─── review phase ───────────────────────────────────────────────────────

  function buildReview(st: StateMsg) {
    const grid = st.grid;
    if (!grid) return;
    const sig = JSON.stringify([st.phase, grid, st.connected]);
    if (sig === reviewSig) return;
    reviewSig = sig;
    const tappable = st.phase === "review" && amParticipant;
    const conn = new Set(st.connected);
    reviewEl.innerHTML = categories
      .map((c, ci) => {
        const chips = players
          .map((p) => {
            const cell = grid[p.playerId]?.[ci] ?? {
              text: "",
              status: "empty" as CellStatus,
              pts: 0,
            };
            const me = p.playerId === ctx.selfPlayerId;
            const canTap =
              tappable &&
              (cell.status === "ok" || cell.status === "dup" || cell.status === "struck");
            const cls = [
              "cat-chip",
              `cat-${cell.status}`,
              me ? "cat-me" : "",
              canTap ? "cat-tappable" : "",
              conn.has(p.playerId) ? "" : "cat-gone",
            ].join(" ");
            const ans =
              cell.status === "empty" ? "—" : cell.text || "—";
            const pts =
              cell.status === "invalid"
                ? `✗ ${escapeHtml(letter)}`
                : cell.status === "struck"
                  ? "✗ 0"
                  : cell.status === "empty"
                    ? "0"
                    : `+${cell.pts}`;
            return `<span class="${cls}" data-pid="${escapeHtml(p.playerId)}" data-ci="${ci}" data-struck="${cell.status === "struck" ? "1" : "0"}">
              <span class="cat-nick">${escapeHtml(p.nickname)}</span>
              <span class="cat-ans">${escapeHtml(ans)}</span>
              <span class="cat-pts">${pts}</span>
            </span>`;
          })
          .join("");
        return `<div class="cat-cat">
          <div class="cat-cat-name">${escapeHtml(c)}</div>
          <div class="cat-chips">${chips}</div>
        </div>`;
      })
      .join("");
  }

  let lastTapAt = 0;
  const onChipTap = (e: Event) => {
    const st = currentState;
    if (!st || st.phase !== "review" || !amParticipant) return;
    const chip = (e.target as HTMLElement | null)?.closest?.(
      ".cat-chip.cat-tappable",
    ) as HTMLElement | null;
    if (!chip) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastTapAt < 120) return;
    lastTapAt = now;
    const pid = chip.dataset.pid!;
    const ci = Number(chip.dataset.ci);
    const struck = chip.dataset.struck === "1";
    ctx.send({ type: "strike", playerId: pid, ci, struck: !struck });
    // Optimistic: flip the class; the next state confirms.
    chip.dataset.struck = struck ? "0" : "1";
    chip.classList.toggle("cat-struck", !struck);
  };
  reviewEl.addEventListener("touchstart", onChipTap, { passive: false });
  reviewEl.addEventListener("mousedown", onChipTap);

  function buildScores(st: StateMsg) {
    const pts = st.points ?? {};
    scoresEl.innerHTML = [...players]
      .sort((a, b) => (pts[b.playerId] ?? 0) - (pts[a.playerId] ?? 0))
      .map(
        (p) =>
          `<span class="cat-score${p.playerId === ctx.selfPlayerId ? " cat-me" : ""}">${escapeHtml(p.nickname)} <b>${pts[p.playerId] ?? 0}</b></span>`,
      )
      .join("");
  }

  const onHostNext = (e: Event) => {
    const btn = (e.target as HTMLElement | null)?.closest?.(
      "[data-action='host-next']",
    );
    if (!btn) return;
    e.preventDefault();
    if (!ctx.isHost()) return;
    ctx.send({ type: "host-next" });
  };
  actionsEl.addEventListener("touchstart", onHostNext, { passive: false });
  actionsEl.addEventListener("mousedown", onHostNext);

  // ─── results ────────────────────────────────────────────────────────────

  function buildResults(st: StateMsg) {
    if (resultsBuilt) return;
    resultsBuilt = true;
    const pts = st.points ?? {};
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
          return `<div class="cat-res-row${v === top && top > 0 ? " cat-top" : ""}">
            <span class="cat-rank">${rank}.</span>
            ${av ? `<img src="${avatarSrc(av)}" alt="" />` : ""}
            <span class="cat-nm">${escapeHtml(p.nickname)}${p.playerId === ctx.selfPlayerId ? " (you)" : ""}</span>
            <span class="cat-p">${v} pts</span>
          </div>`;
        })
        .join("") +
      `<div class="cat-note">unique +${scoring.unique} · duplicate +${scoring.dup} · struck / wrong letter 0</div>`;
  }

  // ─── state ──────────────────────────────────────────────────────────────

  function refreshCountdown() {
    const st = currentState;
    if (!st) return;
    const s = secsLeft(st.phaseEndsAt);
    if (st.phase === "write" || st.phase === "review") {
      countEl.textContent = String(s);
      countEl.classList.toggle("cat-hurry", s <= 10);
    } else {
      countEl.textContent = "";
      countEl.classList.remove("cat-hurry");
    }
  }
  const countdownTimer = setInterval(refreshCountdown, 250);

  function applyState(msg: StateMsg) {
    currentState = msg;
    if (!built) {
      categories = msg.categories;
      letter = msg.letter;
      letterEl.textContent = letter;
    }
    if (msg.doneIds.includes(ctx.selfPlayerId)) iAmDone = true;
    else if (iAmDone && msg.phase === "write") {
      // We tapped STOP but the server hasn't confirmed — re-send answers +
      // done (throttled) so a dropped message can't strand us in "waiting".
      const now = Date.now();
      if (now - lastDoneResendAt > 1000) {
        lastDoneResendAt = now;
        sendAnswersNow();
        ctx.send({ type: "done" });
      }
    }

    statusEl.textContent = statusLine(
      "categories",
      msg.phase === "write"
        ? "writing"
        : msg.phase === "review"
          ? "review"
          : "results",
      `${msg.doneIds.length}/${msg.connected.length} done`,
    );

    if (amParticipant && msg.points) {
      ctx.setMatchScore(`you: ${msg.points[ctx.selfPlayerId] ?? 0} pts`);
    } else if (amParticipant) {
      ctx.setMatchScore(`letter ${letter}`);
    } else {
      ctx.setMatchScore(null);
    }

    const write = msg.phase === "write";
    const review = msg.phase === "review";
    const results = msg.phase === "results" || msg.phase === "ended";

    formEl.hidden = !write;
    doneLineEl.hidden = !write;
    reviewEl.hidden = !review;
    scoresEl.hidden = !review;
    resultsEl.hidden = !results;
    refreshCountdown();

    if (write) {
      buildForm();
      updateActions();
      bannerEl.textContent = iAmDone ? "WAITING…" : "GO — 4 answers!";
      subEl.textContent = msg.stopperId
        ? `${nickOf(msg.stopperId)} stopped — hurry!`
        : "";
      doneLineEl.textContent = "";
    } else if (review) {
      // Blur any input so the keyboard goes away.
      (document.activeElement as HTMLElement | null)?.blur?.();
      buildReview(msg);
      buildScores(msg);
      bannerEl.textContent = "REVIEW";
      subEl.textContent = "";
      if (ctx.isHost() && amParticipant) {
        actionsEl.hidden = false;
        if (actionsBuiltFor !== "host-next") {
          actionsBuiltFor = "host-next";
          actionsEl.innerHTML = `<button class="cat-btn cat-ghost" type="button" data-action="host-next">END REVIEW ▸</button>`;
        }
      } else {
        actionsEl.hidden = true;
      }
    } else if (results) {
      actionsEl.hidden = true;
      buildResults(msg);
      bannerEl.textContent = "RESULTS";
      subEl.textContent = "";
      if (!flashedResults) {
        flashedResults = true;
        const pts = msg.points ?? {};
        const mine = pts[ctx.selfPlayerId] ?? 0;
        flash.flash(amParticipant ? `${mine} PTS` : "RESULTS");
      }
    }
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      clearInterval(countdownTimer);
      if (sendTimer) clearTimeout(sendTimer);
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

const CategoriesClient: MiniGameClientDefinition = {
  id: "categories",
  controlsHint:
    "type 4 things starting with the letter — first to fill all four taps STOP, then the room reviews: unique 10, duplicate 5",
  createMatch: createCategoriesMatchClient,
};

registerMiniGameClient(CategoriesClient);

export default CategoriesClient;
