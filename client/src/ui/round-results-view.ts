// Round-results screen — shown briefly after a mini-game ends. Auto-dismisses
// after a server-side timeout, or GM can dismiss early.

import { avatarSrc } from "../identity";
import type { PublicPlayer, RoundResult } from "../../../party/protocol";

export type RoundResultsHandlers = {
  onBackToLobby: () => void;
};

export function renderRoundResultsView(
  args: {
    result: RoundResult;
    players: PublicPlayer[];
    selfPlayerId: string | null;
    isGm: boolean;
  },
  container: HTMLElement,
  handlers: RoundResultsHandlers,
): void {
  const { result, players, selfPlayerId, isGm } = args;
  // Sort participants by points desc.
  const rows = result.participants
    .map((id) => ({
      player: players.find((p) => p.playerId === id) ?? null,
      points: result.scores[id] ?? 0,
    }))
    .sort((a, b) => b.points - a.points);

  container.innerHTML = `
    <div class="results">
      <div class="results-title">Round results</div>
      ${result.summary ? `<div class="results-summary">${escapeHtml(result.summary)}</div>` : ""}
      <div class="results-list">
        ${rows
          .map(
            (r, i) => `
          <div class="results-row ${selfPlayerId && r.player?.playerId === selfPlayerId ? "self" : ""}">
            <span class="rank">${i + 1}</span>
            <span class="avatar"><img src="${avatarSrc(r.player?.avatarId ?? "bean")}" alt="" /></span>
            <span class="name">${escapeHtml(r.player?.nickname ?? "?")}</span>
            <span class="points">${r.points}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="results-actions">
        ${isGm ? `<button class="primary" id="back-btn">back to lobby</button>` : `<div class="hint">returning to lobby…</div>`}
      </div>
    </div>
  `;

  if (isGm) {
    container.querySelector<HTMLButtonElement>("#back-btn")?.addEventListener("click", () => {
      handlers.onBackToLobby();
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
