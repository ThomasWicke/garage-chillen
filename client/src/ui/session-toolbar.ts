// Persistent session toolbar — sits above the active scene and renders
// session-level info. Two display modes:
//
//   • Lobby mode (idle / round-results / session-results):
//       LOBBY-CODE  ……  SESSION-SCORE 🔥
//
//   • Match mode (preparing / playing):
//       MINI-GAME-NAME  ……  MATCH-SCORE
//
// The match score is pushed by the active mini-game via
// MiniGameClientContext.setMatchScore — that's how every mini-game gets to
// render its match-relevant info on the universal toolbar without
// reinventing the bar itself. Phase 6 will mount the ADHD-King clicker
// button on the right.

import { fireData } from "@kaplayjs/crew";
import type { LobbyState, MiniGameInfo, PublicPlayer } from "../../../party/protocol";

const FIRE_SRC = fireData.kind === "Sprite" ? fireData.outlined : "";

export type ToolbarState = {
  code: string;
  status: "connecting" | "open" | "closed";
  selfPlayerId: string | null;
  players: PublicPlayer[];
  lobbyState: LobbyState;
  activeMinigameId: string | null;
  availableMinigames: MiniGameInfo[];
  sessionScores: Record<string, number>;
  matchScore: string | null;
};

export function renderSessionToolbar(s: ToolbarState, container: HTMLElement): void {
  const inMatch = s.lobbyState === "preparing" || s.lobbyState === "playing";
  const dotClass =
    s.status === "open" ? "ok" : s.status === "connecting" ? "warn" : "bad";

  if (inMatch) {
    const mg = s.availableMinigames.find((m) => m.id === s.activeMinigameId);
    container.innerHTML = `
      <div class="toolbar-section toolbar-left">
        <span class="toolbar-dot ${dotClass}" title="${s.status}"></span>
        <span class="toolbar-mg">${escapeHtml(mg?.displayName ?? "")}</span>
      </div>
      <div class="toolbar-section toolbar-right">
        ${
          s.matchScore !== null
            ? `<span class="toolbar-match-score">${escapeHtml(s.matchScore)}</span>`
            : ""
        }
      </div>
    `;
    return;
  }

  const myScore = s.selfPlayerId ? s.sessionScores[s.selfPlayerId] ?? 0 : 0;
  container.innerHTML = `
    <div class="toolbar-section toolbar-left">
      <span class="toolbar-dot ${dotClass}" title="${s.status}"></span>
      <span class="toolbar-code">${s.code}</span>
    </div>
    <div class="toolbar-section toolbar-right">
      <span class="toolbar-score">${myScore}</span>
      <img class="toolbar-icon" src="${FIRE_SRC}" alt="" />
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
