// Pure DOM rendering for the lobby. State-in, HTML-out. Phase 1 only shows
// player list + GM marker + connection status; mini-game launching comes in
// Phase 2.

import { avatarEmoji } from "../identity";
import type { LobbyState, PublicPlayer } from "../../../party/protocol";

export type LobbyViewState = {
  code: string;
  status: "connecting" | "open" | "closed";
  selfPlayerId: string | null;
  players: PublicPlayer[];
  gmPlayerId: string | null;
  gmGraceUntil: number | null;
  lobbyState: LobbyState;
};

export function renderLobbyView(s: LobbyViewState, container: HTMLElement): void {
  const isSelfGm = !!s.selfPlayerId && s.gmPlayerId === s.selfPlayerId;
  const graceMsLeft =
    s.gmGraceUntil !== null ? Math.max(0, s.gmGraceUntil - Date.now()) : 0;
  const inGmGrace = graceMsLeft > 0;

  container.innerHTML = `
    <div class="lobby">
      <div class="header">
        <div class="code-block">
          <span class="label">Lobby</span>
          <span class="code">${s.code}</span>
        </div>
        <span class="status">${statusText(s.status, inGmGrace, graceMsLeft)}</span>
      </div>
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
            ? `<div class="hint">you are the Game Master · mini-game launching coming next</div>`
            : `<div class="hint">waiting for the Game Master…</div>`
        }
      </div>
    </div>
  `;
}

function renderPlayer(p: PublicPlayer, selfPlayerId: string | null): string {
  const classes = ["player"];
  if (p.isGm) classes.push("gm");
  if (selfPlayerId && p.playerId === selfPlayerId) classes.push("self");
  if (!p.connected) classes.push("disconnected");
  return `
    <div class="${classes.join(" ")}">
      <span class="avatar">${avatarEmoji(p.avatarId)}</span>
      <span class="name">${escapeHtml(p.nickname)}</span>
      <span class="badge">
        ${p.isGm ? `<span class="crown">👑 GM</span>` : ""}
        ${!p.connected ? "offline" : ""}
      </span>
    </div>
  `;
}

function statusText(
  status: "connecting" | "open" | "closed",
  inGmGrace: boolean,
  graceMsLeft: number,
): string {
  if (status === "connecting") return "connecting…";
  if (status === "closed") return "reconnecting…";
  if (inGmGrace) return `GM grace ${Math.ceil(graceMsLeft / 1000)}s`;
  return "connected";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
