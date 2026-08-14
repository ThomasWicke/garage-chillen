// Ten Seconds client. Pure DOM. A big monospace count-up runs from the
// broadcast roundStartAt; at 3.00s it hides ("…keep counting!") and a subtle
// pulsing dot takes over. Giant STOP button in the bottom half — one tap,
// then you're "locked in" (your time stays secret until results). Results
// phase lists everyone's stopped time + signed error, best first.

import { avatarSrc } from "../../identity";
import { createMatchFlash, type MatchFlash } from "../flash";
import { formatRemaining, statusLine } from "../clock";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "arm" | "counting" | "results";

type WelcomeMsg = {
  type: "welcome";
  rounds: number;
  armMs: number;
  visibleMs: number;
  targetMs: number;
  maxCountMs: number;
  resultsMs: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type RoundRow = {
  playerId: string;
  elapsedMs: number | null;
  signedErrorMs: number | null;
  roundPoints: number;
};

type StateMsg = {
  type: "state";
  phase: Phase;
  round: number;
  rounds: number;
  phaseUntil: number;
  roundStartAt: number;
  tappedIds: string[];
  totals: Record<string, number>;
  results: RoundRow[] | null;
  deadlineAt: number;
};

function createTenSecondsMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="ts-root" id="ts-root">
      <style>
        .ts-root {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          background: #0a0a14;
          color: #f2f2f5;
          font-family: system-ui, -apple-system, sans-serif;
          overflow: hidden;
          user-select: none;
          -webkit-user-select: none;
        }
        .ts-status {
          padding: 8px 12px 0;
          font-size: 13px;
          color: #9a9aa5;
          text-align: center;
        }
        .ts-banner {
          padding: 6px 16px;
          font-size: 17px;
          font-weight: 600;
          text-align: center;
          min-height: 26px;
        }
        .ts-stage {
          flex: 1 1 auto;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          min-height: 0;
        }
        .ts-timer {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: clamp(56px, 22vw, 110px);
          font-weight: 700;
          letter-spacing: 2px;
          color: #f2f2f5;
          font-variant-numeric: tabular-nums;
        }
        .ts-dot {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #abdd64;
          animation: ts-pulse 1s ease-in-out infinite;
        }
        @keyframes ts-pulse {
          0%, 100% { transform: scale(1); opacity: 0.35; }
          50% { transform: scale(1.5); opacity: 0.9; }
        }
        .ts-locked {
          font-size: 26px;
          font-weight: 700;
          color: #abdd64;
          letter-spacing: 1px;
          animation: ts-lockin 0.35s ease-out;
        }
        @keyframes ts-lockin {
          from { transform: scale(1.6); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .ts-results {
          width: 100%;
          height: 100%;
          overflow-y: auto;
          padding: 4px 12px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .ts-row {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #14141f;
          border-radius: 10px;
          padding: 6px 10px;
          font-size: 15px;
        }
        .ts-row.ts-self {
          outline: 2px solid #abdd64;
        }
        .ts-row img {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          flex: 0 0 auto;
        }
        .ts-row-nick {
          flex: 1 1 auto;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ts-row-time {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-variant-numeric: tabular-nums;
          color: #f2f2f5;
        }
        .ts-row-err {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-variant-numeric: tabular-nums;
          color: #9a9aa5;
          min-width: 62px;
          text-align: right;
        }
        .ts-row-pts {
          min-width: 30px;
          text-align: right;
          font-weight: 700;
          color: #abdd64;
        }
        .ts-stop {
          flex: 0 0 45%;
          margin: 10px 14px 14px;
          border: none;
          border-radius: 20px;
          background: #e0524a;
          color: #fff;
          font-size: clamp(34px, 12vw, 56px);
          font-weight: 800;
          letter-spacing: 3px;
          touch-action: manipulation;
          cursor: pointer;
        }
        .ts-stop:active { filter: brightness(1.15); }
        .ts-stop:disabled {
          background: #2a2a3a;
          color: #abdd64;
          font-size: clamp(20px, 7vw, 30px);
          letter-spacing: 2px;
        }
        .ts-stop[hidden] { display: none; }
      </style>
      <div class="ts-status" id="ts-status"></div>
      <div class="ts-banner" id="ts-banner">get ready…</div>
      <div class="ts-stage" id="ts-stage">
        <div class="ts-timer" id="ts-timer" hidden>0.00</div>
        <div class="ts-dot" id="ts-dot" hidden></div>
        <div class="ts-locked" id="ts-locked" hidden>locked in</div>
        <div class="ts-results" id="ts-results" hidden></div>
      </div>
      <button class="ts-stop" id="ts-stop" type="button" hidden>STOP</button>
    </div>
  `;
  const rootEl = ctx.container.querySelector<HTMLElement>("#ts-root")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#ts-status")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#ts-banner")!;
  const timerEl = ctx.container.querySelector<HTMLElement>("#ts-timer")!;
  const dotEl = ctx.container.querySelector<HTMLElement>("#ts-dot")!;
  const lockedEl = ctx.container.querySelector<HTMLElement>("#ts-locked")!;
  const resultsEl = ctx.container.querySelector<HTMLElement>("#ts-results")!;
  const stopBtn = ctx.container.querySelector<HTMLButtonElement>("#ts-stop")!;

  const flash: MatchFlash = createMatchFlash(rootEl);

  let players: WelcomeMsg["players"] = [];
  let welcomed = false;
  let visibleMs = 3_000;
  let rounds = 3;

  // Latest server state (the rAF display loop reads these).
  let phase: Phase = "arm";
  let round = 1;
  let roundStartAt = 0;
  let tappedIds = new Set<string>();
  let deadlineAt = 0;

  /** Optimistic lock so the button freezes on touchstart, before the next
   *  state broadcast confirms. Reset whenever a new round's count starts. */
  let localLockedForStartAt = 0;
  let renderedResultsRound = 0;
  let flashedRound = 0;
  let lastTapAt = 0;

  const isParticipant =
    !ctx.isSpectator &&
    ctx.participants.some((p) => p.playerId === ctx.selfPlayerId);

  const tap = (e: Event) => {
    if (ctx.isSpectator) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapAt < 80) return;
    lastTapAt = now;
    if (phase !== "counting" || myLocked()) return;
    localLockedForStartAt = roundStartAt;
    ctx.send({ type: "stop" });
    render();
  };
  if (isParticipant) {
    stopBtn.addEventListener("touchstart", tap, { passive: false });
    stopBtn.addEventListener("mousedown", tap);
  }

  function myLocked(): boolean {
    return (
      tappedIds.has(ctx.selfPlayerId) ||
      (localLockedForStartAt !== 0 && localLockedForStartAt === roundStartAt)
    );
  }

  /** Display loop — recomputes the count-up from roundStartAt between 30Hz
   *  state broadcasts so the visible 0.00→3.00 run is smooth. */
  let rafId = 0;
  function loop() {
    render();
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  function render() {
    const roundLabel = `round ${Math.min(round, rounds)}/${rounds}`;
    const clock = deadlineAt > 0 ? formatRemaining(deadlineAt) : "";
    const stopped =
      phase === "counting" ? `${tappedIds.size}/${players.length || ctx.participants.length} stopped` : "";
    statusEl.textContent = statusLine(roundLabel, stopped, clock);

    const locked = myLocked();
    const showResults = phase === "results";
    resultsEl.hidden = !showResults;

    if (phase === "counting" && roundStartAt > 0) {
      const elapsed = Date.now() - roundStartAt;
      const visible = elapsed < visibleMs;
      timerEl.hidden = locked || !visible;
      dotEl.hidden = locked || visible;
      lockedEl.hidden = !locked;
      if (!timerEl.hidden) {
        timerEl.textContent = (Math.max(0, elapsed) / 1000).toFixed(2);
      }
      if (ctx.isSpectator) {
        bannerEl.textContent = visible ? "they're counting…" : "…heads are counting!";
      } else if (locked) {
        bannerEl.textContent = "locked in — wait for the others…";
      } else {
        bannerEl.textContent = visible ? "count along…" : "…keep counting!";
      }
    } else {
      timerEl.hidden = true;
      dotEl.hidden = true;
      lockedEl.hidden = true;
      if (phase === "arm") {
        bannerEl.textContent = `round ${round} · get ready — stop at exactly 10 seconds`;
      } else if (phase === "results") {
        bannerEl.textContent = `round ${round} results`;
      }
    }

    // STOP button: only for participants, only while counting.
    const showBtn = isParticipant && phase === "counting";
    stopBtn.hidden = !showBtn;
    if (showBtn) {
      stopBtn.disabled = locked;
      stopBtn.textContent = locked ? "LOCKED IN" : "STOP";
    }
  }

  function fmtSigned(ms: number): string {
    const sign = ms >= 0 ? "+" : "−";
    return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}s`;
  }

  function renderResults(rowsIn: RoundRow[], totals: Record<string, number>) {
    resultsEl.innerHTML = rowsIn
      .map((r) => {
        const p = players.find((pp) => pp.playerId === r.playerId);
        const self = r.playerId === ctx.selfPlayerId ? " ts-self" : "";
        const time =
          r.elapsedMs === null ? "—" : `${(r.elapsedMs / 1000).toFixed(2)}s`;
        const err = r.signedErrorMs === null ? "—" : fmtSigned(r.signedErrorMs);
        const pts = r.roundPoints > 0 ? `+${r.roundPoints}` : "";
        const total = totals[r.playerId] ?? 0;
        return `<div class="ts-row${self}">
          <img src="${p ? avatarSrc(p.avatarId) : ""}" alt="" />
          <div class="ts-row-nick">${escapeHtml(p?.nickname ?? "?")} <span style="color:#9a9aa5;">· ${total} pts</span></div>
          <div class="ts-row-time">${time}</div>
          <div class="ts-row-err">${err}</div>
          <div class="ts-row-pts">${pts}</div>
        </div>`;
      })
      .join("");
  }

  function applyWelcome(msg: WelcomeMsg) {
    if (welcomed) return; // replayed on reconnect — scene shell already built
    welcomed = true;
    players = msg.players;
    rounds = msg.rounds;
    if (Number.isFinite(msg.visibleMs)) visibleMs = msg.visibleMs;
    deadlineAt = msg.deadlineAt;
  }

  function applyState(msg: StateMsg) {
    phase = msg.phase;
    round = msg.round;
    rounds = msg.rounds ?? rounds;
    roundStartAt = msg.roundStartAt;
    tappedIds = new Set(msg.tappedIds ?? []);
    deadlineAt = msg.deadlineAt ?? deadlineAt;

    if (isParticipant) {
      ctx.setMatchScore(`${msg.totals[ctx.selfPlayerId] ?? 0} pts`);
    } else {
      const best = Math.max(0, ...Object.values(msg.totals));
      ctx.setMatchScore(`best ${best} pts`);
    }

    if (msg.phase === "results" && msg.results) {
      if (renderedResultsRound !== msg.round) {
        renderedResultsRound = msg.round;
        renderResults(msg.results, msg.totals);
        const mine = msg.results.find((r) => r.playerId === ctx.selfPlayerId);
        if (
          isParticipant &&
          mine &&
          mine.roundPoints === 3 &&
          flashedRound !== msg.round
        ) {
          flashedRound = msg.round;
          flash.flash("+3");
        }
      }
    }

    render();
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      cancelAnimationFrame(rafId);
      flash.destroy();
      ctx.setMatchScore(null);
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

const TenSecondsClient: MiniGameClientDefinition = {
  id: "ten-seconds",
  controlsHint: "the clock hides at 3s — tap STOP at exactly 10 seconds!",
  createMatch: createTenSecondsMatchClient,
};

registerMiniGameClient(TenSecondsClient);

export default TenSecondsClient;
