// Session-results screen — the finale after a shuffle run completes. Shows
// the final standings with a podium for the top three and the full ranked
// list below. Auto-dismisses server-side; GM can dismiss early.

import { avatarSrc } from "../identity";
import type { PublicPlayer } from "../../../party/protocol";

export type SessionResultsHandlers = {
  onBackToLobby: () => void;
};

export function renderSessionResultsView(
  args: {
    players: PublicPlayer[];
    scores: Record<string, number>;
    selfPlayerId: string | null;
    isGm: boolean;
  },
  container: HTMLElement,
  handlers: SessionResultsHandlers,
): void {
  const { players, scores, selfPlayerId, isGm } = args;

  // Rank every known player by session score (players with 0 included —
  // they sat through the run too).
  const ranked = players
    .map((p) => ({ player: p, points: scores[p.playerId] ?? 0 }))
    .sort((a, b) => b.points - a.points);

  const podium = ranked.slice(0, 3);
  // Render podium visually as 2nd · 1st · 3rd.
  const podiumOrder = [podium[1], podium[0], podium[2]].filter(
    (e): e is NonNullable<typeof e> => !!e,
  );
  const placeOf = (e: { player: PublicPlayer }) =>
    ranked.findIndex((r) => r.player.playerId === e.player.playerId) + 1;

  container.innerHTML = `
    <div class="finale">
      <div class="finale-title">Final standings</div>
      <div class="finale-podium">
        ${podiumOrder
          .map((e) => {
            const place = placeOf(e);
            return `
          <div class="finale-step finale-step--${place} ${
            selfPlayerId && e.player.playerId === selfPlayerId ? "self" : ""
          }">
            <img src="${avatarSrc(e.player.avatarId)}" alt="" />
            <div class="finale-step-name">${escapeHtml(e.player.nickname)}</div>
            <div class="finale-step-block">
              <span class="finale-step-place">${place}</span>
              <span class="finale-step-points">${e.points} pts</span>
            </div>
          </div>`;
          })
          .join("")}
      </div>
      ${
        ranked.length > 3
          ? `<div class="results-list">
              ${ranked
                .slice(3)
                .map(
                  (r, i) => `
                <div class="results-row ${
                  selfPlayerId && r.player.playerId === selfPlayerId ? "self" : ""
                }">
                  <span class="rank">${i + 4}</span>
                  <span class="avatar"><img src="${avatarSrc(r.player.avatarId)}" alt="" /></span>
                  <span class="name">${escapeHtml(r.player.nickname)}</span>
                  <span class="points">${r.points}</span>
                </div>`,
                )
                .join("")}
            </div>`
          : ""
      }
      <div class="results-actions">
        ${
          isGm
            ? `<button class="primary" id="finale-back-btn">back to lobby</button>`
            : `<div class="hint">what a run!</div>`
        }
      </div>
    </div>
  `;

  if (isGm) {
    container
      .querySelector<HTMLButtonElement>("#finale-back-btn")
      ?.addEventListener("click", () => handlers.onBackToLobby());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
