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
  /** Test lobby + self is GM: show an "abort round" control during play. */
  testAbort?: boolean;
};

export type ToolbarHandlers = {
  onAbort?: () => void;
};

export function renderSessionToolbar(
  s: ToolbarState,
  container: HTMLElement,
  handlers: ToolbarHandlers = {},
): void {
  const inMatch = s.lobbyState === "preparing" || s.lobbyState === "playing";
  const dotClass =
    s.status === "open" ? "ok" : s.status === "connecting" ? "warn" : "bad";

  if (inMatch) {
    const mg = s.availableMinigames.find((m) => m.id === s.activeMinigameId);
    // Mini-games push the match score on every state broadcast (30Hz). A
    // full innerHTML rebuild that often replaces the abort button between
    // touchstart and touchend, so taps never produce a click. Only rebuild
    // when the STRUCTURE changes; otherwise patch the score text in place.
    const structureKey = [
      "match",
      dotClass,
      mg?.displayName ?? "",
      s.matchScore !== null ? "score" : "noscore",
      s.testAbort ? "abort" : "",
    ].join("|");
    if (container.dataset.toolbarKey !== structureKey) {
      container.dataset.toolbarKey = structureKey;
      container.innerHTML = `
        <div class="toolbar-section toolbar-left">
          <span class="toolbar-dot ${dotClass}" title="${s.status}"></span>
          <span class="toolbar-mg">${escapeHtml(mg?.displayName ?? "")}</span>
        </div>
        <div class="toolbar-section toolbar-right">
          ${s.matchScore !== null ? `<span class="toolbar-match-score"></span>` : ""}
          ${
            s.testAbort
              ? `<button class="toolbar-abort" data-action="test-abort" title="abort round (test lobby)">✕</button>`
              : ""
          }
        </div>
      `;
      container
        .querySelector<HTMLButtonElement>("[data-action='test-abort']")
        ?.addEventListener("click", () => handlers.onAbort?.());
    }
    const scoreEl = container.querySelector<HTMLElement>(".toolbar-match-score");
    if (scoreEl && s.matchScore !== null && scoreEl.textContent !== s.matchScore) {
      scoreEl.textContent = s.matchScore;
    }
    return;
  }
  delete container.dataset.toolbarKey;

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
