// DOM rendering for the lobby (idle state). Shows player list, GM-only
// minigame launch buttons, and connection status.

import { starData } from "@kaplayjs/crew";
import { avatarSrc } from "../identity";
import type {
  MiniGameInfo,
  PublicPlayer,
} from "../../../party/protocol";

const STAR_SRC = starData.kind === "Sprite" ? starData.outlined : "";

export type LobbyViewState = {
  selfPlayerId: string | null;
  players: PublicPlayer[];
  gmPlayerId: string | null;
  availableMinigames: MiniGameInfo[];
};

export type LobbyViewHandlers = {
  onStartRound: (minigameId: string) => void;
};

export function renderLobbyView(
  s: LobbyViewState,
  container: HTMLElement,
  handlers: LobbyViewHandlers,
): void {
  const isSelfGm = !!s.selfPlayerId && s.gmPlayerId === s.selfPlayerId;
  const connectedCount = s.players.filter((p) => p.connected).length;

  container.innerHTML = `
    <div class="lobby">
      <div class="player-list">
        ${
          s.players.length === 0
            ? `<div class="player"><span class="name" style="color: var(--muted);">no players yet…</span></div>`
            : s.players.map((p) => renderPlayer(p, s.selfPlayerId)).join("")
        }
      </div>
      <div class="gm-controls">
        ${
          isSelfGm
            ? renderGmControls(s.availableMinigames, connectedCount)
            : `<div class="hint">waiting for the Game Master…</div>`
        }
      </div>
    </div>
  `;

  if (isSelfGm) {
    container.querySelectorAll<HTMLButtonElement>("[data-start-minigame]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.startMinigame!;
        handlers.onStartRound(id);
      });
    });
  }
}

function renderGmControls(minigames: MiniGameInfo[], connectedCount: number): string {
  if (minigames.length === 0) {
    return `<div class="hint">no mini-games available</div>`;
  }
  const buttons = minigames
    .map((m) => {
      // Phase 2: gate strictly on min/max range. Bracket-mode (Phase 3) will
      // unlock 1v1 mini-games for N>2.
      const ok = connectedCount >= m.minPlayers && connectedCount <= m.maxPlayers;
      const reason = ok
        ? ""
        : connectedCount < m.minPlayers
          ? `needs ${m.minPlayers}+ players`
          : `max ${m.maxPlayers} players`;
      return `
        <button class="primary mg-btn" data-start-minigame="${m.id}" ${ok ? "" : "disabled"}>
          <span class="mg-name">${escapeHtml(m.displayName)}</span>
          ${reason ? `<span class="mg-reason">${escapeHtml(reason)}</span>` : ""}
        </button>
      `;
    })
    .join("");
  return `
    <div class="hint">you are the Game Master · pick a mini-game to start a round</div>
    <div class="mg-list">${buttons}</div>
  `;
}

function renderPlayer(p: PublicPlayer, selfPlayerId: string | null): string {
  const classes = ["player"];
  if (p.isGm) classes.push("gm");
  if (selfPlayerId && p.playerId === selfPlayerId) classes.push("self");
  if (!p.connected) classes.push("disconnected");
  return `
    <div class="${classes.join(" ")}">
      <span class="avatar"><img src="${avatarSrc(p.avatarId)}" alt="" /></span>
      <span class="name">${escapeHtml(p.nickname)}</span>
      <span class="badge">
        ${p.isGm ? `<img class="gm-star" src="${STAR_SRC}" alt="GM" />` : ""}
        ${!p.connected ? `<span class="offline-tag">offline</span>` : ""}
      </span>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
