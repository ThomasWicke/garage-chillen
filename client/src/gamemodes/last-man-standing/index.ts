// LastManStandingGamemode client. Owns the scene region during a round:
// renders the intro overlay (countdown + player roster), then mounts the
// per-match client when the gamemode transitions to phase=playing.
//
// View transitions:
//   • phase=intro     → intro overlay with countdown
//   • phase=playing   → mini-game's match scene (full-screen)
//   • phase=complete  → flashes briefly before lobby moves to round-results

import { avatarSrc } from "../../identity";
import type {
  MatchClientContext,
  MatchClientSession,
} from "../../minigames/types";
import { registerGamemodeClient } from "../registry";
import type {
  GamemodeClientContext,
  GamemodeClientDefinition,
  GamemodeClientSession,
} from "../types";

type Phase = "intro" | "playing" | "complete";

type LmsState = {
  type: "lms-state";
  phase: Phase;
  phaseEndsAt: number | null;
  matchId: string;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

function createLmsClientSession(
  ctx: GamemodeClientContext,
): GamemodeClientSession {
  ctx.container.innerHTML = `
    <div class="lms">
      <div class="lms-intro" id="lms-intro" hidden></div>
      <div class="lms-match" id="lms-match" hidden></div>
    </div>
  `;
  const introEl = ctx.container.querySelector<HTMLElement>("#lms-intro")!;
  const matchEl = ctx.container.querySelector<HTMLElement>("#lms-match")!;

  let lmsState: LmsState | null = null;
  let activeMatchSession: MatchClientSession | null = null;
  let activeMatchId: string | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function isParticipant(): boolean {
    if (!lmsState) return false;
    return lmsState.players.some((p) => p.playerId === ctx.selfPlayerId);
  }

  function rerender() {
    if (!lmsState) {
      introEl.hidden = false;
      matchEl.hidden = true;
      introEl.innerHTML = `<div class="lms-empty">starting…</div>`;
      return;
    }

    if (lmsState.phase === "playing" && isParticipant()) {
      introEl.hidden = true;
      matchEl.hidden = false;
      if (activeMatchId !== lmsState.matchId) {
        mountMatch(lmsState.matchId);
      }
      return;
    }

    if (activeMatchSession) unmountMatch();
    introEl.hidden = false;
    matchEl.hidden = true;
    renderIntroView();
  }

  function mountMatch(matchId: string) {
    unmountMatch();
    matchEl.innerHTML = "";
    activeMatchId = matchId;
    const participants = (lmsState?.players ?? []).map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarId: p.avatarId,
    }));
    const matchCtx: MatchClientContext = {
      container: matchEl,
      matchId,
      selfPlayerId: ctx.selfPlayerId,
      participants,
      send: (m) => ctx.sendMatch(matchId, m),
      setMatchScore: (text) => ctx.setMatchScore(text),
    };
    try {
      activeMatchSession = ctx.miniGame.createMatch(matchCtx);
    } catch (e) {
      console.error("[lms] match create err", e);
      activeMatchSession = null;
      activeMatchId = null;
    }
  }

  function unmountMatch() {
    if (activeMatchSession) {
      try {
        activeMatchSession.unmount();
      } catch (e) {
        console.error("[lms] match unmount err", e);
      }
    }
    activeMatchSession = null;
    activeMatchId = null;
    matchEl.innerHTML = "";
    ctx.setMatchScore(null);
  }

  function renderIntroView() {
    if (!lmsState) return;
    let body = "";
    if (lmsState.phase === "intro") {
      const sec = lmsState.phaseEndsAt
        ? Math.max(0, Math.ceil((lmsState.phaseEndsAt - Date.now()) / 1000))
        : 0;
      body = `
        <div class="lms-title">${escapeHtml(ctx.miniGameDisplayName)}</div>
        <div class="lms-subtitle">Last One Standing</div>
        <div class="lms-countdown">${sec}</div>
        <div class="lms-roster">${
          lmsState.players
            .map(
              (p) => `
            <div class="lms-roster-item ${
              p.playerId === ctx.selfPlayerId ? "self" : ""
            }">
              <img src="${avatarSrc(p.avatarId)}" alt="" />
              <span>${escapeHtml(p.nickname)}</span>
            </div>`,
            )
            .join("")
        }</div>
      `;
    } else if (lmsState.phase === "playing" && !isParticipant()) {
      body = `<div class="lms-spectating">match in progress · spectating</div>`;
    } else if (lmsState.phase === "complete") {
      body = `<div class="lms-complete">match complete</div>`;
    }
    introEl.innerHTML = body;
  }

  function ensureCountdown() {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => {
      if (!lmsState) return;
      if (lmsState.phase === "intro" && !isParticipantInActiveMatch()) {
        renderIntroView();
      }
    }, 250);
  }
  function isParticipantInActiveMatch(): boolean {
    return !!activeMatchSession;
  }
  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  return {
    onGamemodeMessage(msg) {
      if (msg.type === "lms-state") {
        lmsState = msg as unknown as LmsState;
        ensureCountdown();
        rerender();
      }
    },
    onMatchMessage(matchId, msg) {
      if (msg.type === "match-ended") {
        if (matchId === activeMatchId) unmountMatch();
        rerender();
        return;
      }
      if (activeMatchSession && matchId === activeMatchId) {
        activeMatchSession.onMessage(msg);
      }
    },
    unmount() {
      clearCountdown();
      unmountMatch();
      ctx.container.innerHTML = "";
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const LmsGamemodeClient: GamemodeClientDefinition = {
  id: "last-man-standing",
  createSession: createLmsClientSession,
};

registerGamemodeClient(LmsGamemodeClient);

export default LmsGamemodeClient;
