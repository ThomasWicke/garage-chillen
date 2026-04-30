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

  const playerNick = new Map<string, string>();
  for (const p of ctx.lobbyPlayers) playerNick.set(p.playerId, p.nickname);
  const playerById = new Map(ctx.lobbyPlayers.map((p) => [p.playerId, p]));

  function nick(playerId: string | null): string {
    if (!playerId) return "—";
    return playerNick.get(playerId) ?? "?";
  }

  // ─── view selection ──────────────────────────────────────────────────────

  function selfActiveMatch(): ActiveMatchInfo | null {
    if (!bracketState) return null;
    if (bracketState.phase !== "round") return null;
    return (
      bracketState.activeMatches.find((m) =>
        m.participants.includes(ctx.selfPlayerId),
      ) ?? null
    );
  }

  function rerender() {
    const myMatch = selfActiveMatch();

    if (myMatch && myMatch.matchId !== activeMatchId) {
      mountMatch(myMatch);
    } else if (!myMatch && activeMatchSession) {
      unmountMatch();
    }

    if (myMatch) {
      // Match scene visible.
      matchEl.hidden = false;
      bracketEl.hidden = true;
    } else {
      // Bracket overlay visible.
      matchEl.hidden = true;
      bracketEl.hidden = false;
      renderBracket();
    }
  }

  function mountMatch(info: ActiveMatchInfo) {
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
      send: (m) => ctx.sendMatch(info.matchId, m),
      setMatchScore: (text) => ctx.setMatchScore(text),
    };
    try {
      activeMatchSession = ctx.miniGame.createMatch(matchCtx);
    } catch (e) {
      console.error("[tournament] match createMatch error", e);
      activeMatchSession = null;
      activeMatchId = null;
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
        if (!selfActiveMatch()) renderBracket();
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
      if (msg.type === "match-ended") {
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
