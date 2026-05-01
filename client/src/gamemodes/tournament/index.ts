// TournamentGamemode client. Owns the scene region during a tournament round:
// renders the bracket overlay (intro, between-rounds, when waiting), and
// mounts the per-match client when the local player is actively in a match.
//
// Server messages this listens for (all under scope:"minigame"):
//   • target:"gamemode", type:"bracket-state" — full bracket + phase + active matches
//   • target:"match", various — forwarded to the match client whose matchId matches
//     and a synthetic "match-ended" type that the gamemode emits when a match completes
//
// View transitions:
//   • phase=intro          → bracket overlay with "starting in N…"
//   • phase=round          → if local player is in an active match: match scene;
//                            otherwise: bracket overlay
//   • phase=between        → bracket overlay with "next round in N…"
//   • phase=complete       → bracket overlay (briefly; lobby transitions to round-results)

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

type Phase = "intro" | "round" | "between" | "complete";

type PublicBracketMatch = {
  matchId: string;
  round: number;
  index: number;
  a: string | null;
  b: string | null;
  winner: string | null;
};

type PublicBracket = {
  rounds: number;
  matches: PublicBracketMatch[];
};

type ActiveMatchInfo = {
  matchId: string;
  participants: string[];
};

type BracketStateMsg = {
  type: "bracket-state";
  phase: Phase;
  currentRound: number;
  phaseEndsAt: number | null;
  bracket: PublicBracket;
  activeMatches: ActiveMatchInfo[];
};

function createTournamentClientSession(
  ctx: GamemodeClientContext,
): GamemodeClientSession {
  ctx.container.innerHTML = `
    <div class="tournament">
      <div class="tournament-bracket" id="t-bracket"></div>
      <div class="tournament-match" id="t-match" hidden></div>
    </div>
  `;
  const bracketEl = ctx.container.querySelector<HTMLElement>("#t-bracket")!;
  const matchEl = ctx.container.querySelector<HTMLElement>("#t-match")!;

  let bracketState: BracketStateMsg | null = null;
  let activeMatchSession: MatchClientSession | null = null;
  let activeMatchId: string | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Cached welcome message per matchId. Match servers broadcast welcome
   * once at match start — clients that mount the match scene LATER (e.g.
   * a spectator cycling between parallel matches) need this replayed,
   * otherwise their scene sits at "connecting…" with no config.
   */
  const welcomeByMatchId = new Map<string, { type: string; [k: string]: unknown }>();

  const playerNick = new Map<string, string>();
  for (const p of ctx.lobbyPlayers) playerNick.set(p.playerId, p.nickname);
  const playerById = new Map(ctx.lobbyPlayers.map((p) => [p.playerId, p]));

  function nick(playerId: string | null): string {
    if (!playerId) return "—";
    return playerNick.get(playerId) ?? "?";
  }

  // ─── view selection ──────────────────────────────────────────────────────

  /**
   * Pick the match the local player should currently see, with their role:
   *   • participant — they're in an active match, mount it with input wired up
   *   • spectator   — they're on a bye but a match is running, watch the
   *                   first active match (matches are deterministically
   *                   ordered by bracket index so all spectators land on the
   *                   same match)
   * Returns null when no match should be shown (intro/between/complete).
   */
  function activeMatchToShow():
    | { info: ActiveMatchInfo; role: "participant" | "spectator" }
    | null {
    if (!bracketState) return null;
    if (bracketState.phase !== "round") return null;
    const own = bracketState.activeMatches.find((m) =>
      m.participants.includes(ctx.selfPlayerId),
    );
    if (own) return { info: own, role: "participant" };
    if (bracketState.activeMatches.length > 0) {
      // Preserve the spectator's manual choice across bracket-state updates.
      // Without this, every state push would yank them back to the first
      // active match.
      const current = bracketState.activeMatches.find(
        (m) => m.matchId === activeMatchId,
      );
      if (current) return { info: current, role: "spectator" };
      return {
        info: bracketState.activeMatches[0],
        role: "spectator",
      };
    }
    return null;
  }

  function rerender() {
    const sel = activeMatchToShow();

    if (sel && sel.info.matchId !== activeMatchId) {
      mountMatch(sel.info, sel.role === "spectator");
    } else if (!sel && activeMatchSession) {
      unmountMatch();
    }

    if (sel) {
      matchEl.hidden = false;
      bracketEl.hidden = true;
      matchEl.classList.toggle("spectating", sel.role === "spectator");
      if (sel.role === "spectator") {
        applySpectatorLabel(sel.info);
      } else {
        matchEl.removeAttribute("data-spectator-label");
      }
    } else {
      matchEl.hidden = true;
      bracketEl.hidden = false;
      matchEl.classList.remove("spectating");
      matchEl.removeAttribute("data-spectator-label");
      renderBracket();
    }
  }

  /**
   * Update the spectator banner with the participants' nicknames. Stored as a
   * data attribute so the CSS `::after` pseudo-element can `attr()` it — keeps
   * the chrome layered on top of the canvas without touching the match's DOM
   * (which gets blown away on every (un)mount).
   */
  function applySpectatorLabel(info: ActiveMatchInfo) {
    const [pidA, pidB] = info.participants;
    matchEl.setAttribute(
      "data-spectator-label",
      `SPECTATING · ${nick(pidA)} vs ${nick(pidB)}`,
    );
  }

  /**
   * Tap-to-cycle: while in spectator mode, a tap anywhere on the scene moves
   * to the next active match. No-ops when there's only one match running, or
   * when the local player is a participant (their taps are gameplay input).
   *
   * Bound to `touchstart` + `mousedown` rather than `click` because Kaplay's
   * internal canvas handlers call `preventDefault` on touchstart, which
   * suppresses the synthesized click on iOS — the click listener would
   * silently never fire on phones.
   */
  let lastCycleAt = 0;
  const cycleHandler = () => {
    if (!matchEl.classList.contains("spectating")) return;
    if (!bracketState) return;
    const now = Date.now();
    if (now - lastCycleAt < 200) return; // dedupe touchstart vs synthesized click
    const matches = bracketState.activeMatches;
    if (matches.length <= 1) return;
    const idx = matches.findIndex((m) => m.matchId === activeMatchId);
    const nextIdx = ((idx >= 0 ? idx : -1) + 1) % matches.length;
    const next = matches[nextIdx];
    if (!next || next.matchId === activeMatchId) return;
    lastCycleAt = now;
    mountMatch(next, true);
    applySpectatorLabel(next);
  };
  matchEl.addEventListener("touchstart", cycleHandler, { passive: true });
  matchEl.addEventListener("mousedown", cycleHandler);

  function mountMatch(info: ActiveMatchInfo, isSpectator: boolean) {
    unmountMatch();
    matchEl.innerHTML = "";
    activeMatchId = info.matchId;
    const participants = info.participants
      .map((pid) => playerById.get(pid))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const matchCtx: MatchClientContext = {
      container: matchEl,
      matchId: info.matchId,
      selfPlayerId: ctx.selfPlayerId,
      participants,
      isSpectator,
      // Spectators should never be sending — defensive no-op.
      send: isSpectator ? () => {} : (m) => ctx.sendMatch(info.matchId, m),
      setMatchScore: (text) => ctx.setMatchScore(text),
    };
    try {
      activeMatchSession = ctx.miniGame.createMatch(matchCtx);
    } catch (e) {
      console.error("[tournament] match createMatch error", e);
      activeMatchSession = null;
      activeMatchId = null;
      return;
    }
    // Replay the cached welcome so a freshly-mounted match (e.g. a spectator
    // cycling in mid-match) gets its config without waiting for the next
    // server-driven welcome (which never comes — welcome is one-shot).
    const cachedWelcome = welcomeByMatchId.get(info.matchId);
    if (cachedWelcome && activeMatchSession) {
      try {
        activeMatchSession.onMessage(cachedWelcome);
      } catch (e) {
        console.error("[tournament] welcome replay error", e);
      }
    }
  }

  function unmountMatch() {
    if (activeMatchSession) {
      try {
        activeMatchSession.unmount();
      } catch (e) {
        console.error("[tournament] match unmount error", e);
      }
    }
    activeMatchSession = null;
    activeMatchId = null;
    matchEl.innerHTML = "";
    ctx.setMatchScore(null);
  }

  // ─── bracket rendering ───────────────────────────────────────────────────

  function renderBracket() {
    if (!bracketState) {
      bracketEl.innerHTML = `<div class="tournament-empty">starting…</div>`;
      return;
    }
    const phaseLabel = phaseLabelFor(bracketState);
    const bracket = bracketState.bracket;
    const totalRounds = bracket.rounds;

    const byRound = new Map<number, PublicBracketMatch[]>();
    for (const m of bracket.matches) {
      const arr = byRound.get(m.round) ?? [];
      arr.push(m);
      byRound.set(m.round, arr);
    }
    for (const arr of byRound.values()) arr.sort((a, b) => a.index - b.index);
    const activeIds = new Set(
      bracketState.activeMatches.map((m) => m.matchId),
    );

    // Symmetric vertical layout for portrait phones:
    //   row 0..N-2 (top half)     — outermost round → semis-top
    //   row N-1                    — final, centered
    //   row N..2N-2 (bottom half) — semis-bottom → outermost round
    // Inside each non-final round: matches with index < count/2 go to the
    // top half, the rest to the bottom half.
    type Row = {
      roundIdx: number;
      matches: PublicBracketMatch[];
      isFinal: boolean;
    };
    const rows: Row[] = [];

    for (let r = 0; r < totalRounds - 1; r++) {
      const ms = byRound.get(r) ?? [];
      rows.push({
        roundIdx: r,
        matches: ms.slice(0, ms.length / 2),
        isFinal: false,
      });
    }
    if (totalRounds > 0) {
      rows.push({
        roundIdx: totalRounds - 1,
        matches: byRound.get(totalRounds - 1) ?? [],
        isFinal: true,
      });
    }
    for (let r = totalRounds - 2; r >= 0; r--) {
      const ms = byRound.get(r) ?? [];
      rows.push({
        roundIdx: r,
        matches: ms.slice(ms.length / 2),
        isFinal: false,
      });
    }

    const rowsHtml = rows
      .map((row) => {
        const matchesHtml = row.matches
          .map((m) => bracketMatchHtml(m, activeIds.has(m.matchId), row.roundIdx))
          .join("");
        const rowClass = row.isFinal ? "tb-row tb-row--final" : "tb-row";
        const labelClass = row.isFinal
          ? "tb-row-label tb-row-label--final"
          : "tb-row-label";
        return `<div class="${rowClass}">
          <div class="${labelClass}">${roundLabel(row.roundIdx, totalRounds)}</div>
          <div class="tb-row-matches">${matchesHtml}</div>
        </div>`;
      })
      .join("");

    bracketEl.innerHTML = `
      <div class="tournament-header">
        <div class="tournament-phase">${phaseLabel.title}</div>
        ${phaseLabel.sub ? `<div class="tournament-phase-sub">${phaseLabel.sub}</div>` : ""}
      </div>
      <div class="tb-vertical">${rowsHtml}</div>
    `;
  }

  function bracketMatchHtml(
    m: PublicBracketMatch,
    isActive: boolean,
    _roundIdx: number,
  ): string {
    const aClass = slotClass(m, "a");
    const bClass = slotClass(m, "b");
    const aLabel = m.a ? escapeHtml(nick(m.a)) : m.b ? "bye" : "—";
    const bLabel = m.b ? escapeHtml(nick(m.b)) : m.a ? "bye" : "—";
    const activeAttr = isActive ? "data-active" : "";
    return `<div class="tb-match" ${activeAttr}>
      <div class="tb-slot ${aClass}">${aLabel}</div>
      <div class="tb-slot ${bClass}">${bLabel}</div>
    </div>`;
  }

  function slotClass(m: PublicBracketMatch, slot: "a" | "b"): string {
    const value = slot === "a" ? m.a : m.b;
    if (!value) return "tb-empty";
    if (m.winner === value) return "tb-winner";
    if (m.winner !== null && m.winner !== value) return "tb-loser";
    if (value === ctx.selfPlayerId) return "tb-self";
    return "";
  }

  function roundLabel(round: number, totalRounds: number): string {
    // Last round = Final; second-to-last = Semis; before that = Quarters; etc.
    const fromEnd = totalRounds - 1 - round;
    if (fromEnd === 0) return "Final";
    if (fromEnd === 1) return "Semifinals";
    if (fromEnd === 2) return "Quarterfinals";
    return `Round ${round + 1}`;
  }

  function phaseLabelFor(s: BracketStateMsg): { title: string; sub?: string } {
    switch (s.phase) {
      case "intro": {
        const sec = s.phaseEndsAt
          ? Math.max(0, Math.ceil((s.phaseEndsAt - Date.now()) / 1000))
          : 0;
        return { title: "Tournament", sub: `Starts in ${sec}…` };
      }
      case "round":
        return {
          title: roundLabel(s.currentRound, s.bracket.rounds),
          sub: "Matches in progress…",
        };
      case "between": {
        const sec = s.phaseEndsAt
          ? Math.max(0, Math.ceil((s.phaseEndsAt - Date.now()) / 1000))
          : 0;
        const nextLabel = roundLabel(s.currentRound + 1, s.bracket.rounds);
        return { title: nextLabel, sub: `Starts in ${sec}…` };
      }
      case "complete": {
        const final = s.bracket.matches[s.bracket.matches.length - 1];
        const champ = final?.winner ? nick(final.winner) : "?";
        return { title: "Champion", sub: champ };
      }
    }
  }

  // Live countdown re-render (intro/between phases).
  function ensureCountdownTimer() {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => {
      if (!bracketState) return;
      if (bracketState.phase === "intro" || bracketState.phase === "between") {
        if (!activeMatchToShow()) renderBracket();
      }
    }, 250);
  }
  function clearCountdownTimer() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // ─── public hooks ────────────────────────────────────────────────────────

  return {
    onGamemodeMessage(msg) {
      if (msg.type === "bracket-state") {
        bracketState = msg as unknown as BracketStateMsg;
        ensureCountdownTimer();
        rerender();
      }
    },
    onMatchMessage(matchId, msg) {
      // Cache welcomes so spectators that mount a match late (via tap-to-
      // cycle) can be replayed the config in mountMatch.
      if (msg.type === "welcome") {
        welcomeByMatchId.set(matchId, msg);
      }
      if (msg.type === "match-ended") {
        welcomeByMatchId.delete(matchId);
        // Synthetic gamemode broadcast — if it's our match, drop the scene.
        // Also patch bracketState locally so rerender doesn't re-mount before
        // the authoritative bracket-state arrives a moment later.
        if (bracketState) {
          bracketState.activeMatches = bracketState.activeMatches.filter(
            (m) => m.matchId !== matchId,
          );
        }
        if (matchId === activeMatchId) {
          unmountMatch();
        }
        rerender();
        return;
      }
      // Forward to active match session if it matches.
      if (activeMatchSession && matchId === activeMatchId) {
        activeMatchSession.onMessage(msg);
      }
    },
    unmount() {
      clearCountdownTimer();
      unmountMatch();
      welcomeByMatchId.clear();
      ctx.container.innerHTML = "";
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const TournamentGamemodeClient: GamemodeClientDefinition = {
  id: "tournament",
  createSession: createTournamentClientSession,
};

registerGamemodeClient(TournamentGamemodeClient);

export default TournamentGamemodeClient;
