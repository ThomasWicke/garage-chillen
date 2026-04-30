// Bottom-sheet drawer for the GM to manually pick a single mini-game. Shows
// the registered mini-games as a 2-column card grid with name, gamemode and
// player-range badge. Disabled cards (lobby player count out of range)
// surface why they can't be picked right now.

import type { MiniGameInfo } from "../../../party/protocol";

export type GamePickerDrawerProps = {
  minigames: MiniGameInfo[];
  connectedCount: number;
  onPick: (minigameId: string) => void;
  onClose: () => void;
};

export function openGamePickerDrawer(props: GamePickerDrawerProps): () => void {
  const overlay = document.createElement("div");
  overlay.className = "drawer-overlay";
  overlay.innerHTML = `
    <div class="drawer-sheet" role="dialog" aria-label="Pick a mini-game">
      <div class="drawer-handle"></div>
      <div class="drawer-header">
        <div class="drawer-title">Pick a mini-game</div>
        <button class="drawer-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="drawer-body" id="drawer-body"></div>
    </div>
  `;

  const sheet = overlay.querySelector<HTMLElement>(".drawer-sheet")!;
  const body = overlay.querySelector<HTMLElement>("#drawer-body")!;
  const closeBtn = overlay.querySelector<HTMLButtonElement>(".drawer-close")!;

  body.innerHTML = props.minigames
    .map((m) => renderCard(m, props.connectedCount))
    .join("");

  body.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pick!;
      props.onPick(id);
      close();
    });
  });

  function close() {
    sheet.classList.add("closing");
    overlay.classList.add("closing");
    setTimeout(() => {
      try {
        document.body.removeChild(overlay);
      } catch {
        /* ignore */
      }
    }, 220);
    props.onClose();
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  // Force reflow so the open transition runs.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  sheet.offsetHeight;
  sheet.classList.add("open");
  overlay.classList.add("open");

  return close;
}

function renderCard(m: MiniGameInfo, connectedCount: number): string {
  const ok =
    connectedCount >= m.minPlayers && connectedCount <= m.maxPlayers;
  const reason = !ok
    ? connectedCount < m.minPlayers
      ? `needs ${m.minPlayers}+ players`
      : `max ${m.maxPlayers} players`
    : "";
  const range = renderRange(m.minPlayers, m.maxPlayers);
  const gmodeLabel = gamemodeLabel(m.gamemode);
  return `
    <button class="picker-card ${ok ? "" : "disabled"}" data-pick="${escapeHtml(m.id)}" ${ok ? "" : "disabled"}>
      <div class="picker-card-name">${escapeHtml(m.displayName)}</div>
      <div class="picker-card-meta">
        <span class="picker-badge gamemode">${escapeHtml(gmodeLabel)}</span>
        <span class="picker-badge range">${escapeHtml(range)}</span>
      </div>
      ${reason ? `<div class="picker-card-reason">${escapeHtml(reason)}</div>` : ""}
    </button>
  `;
}

function renderRange(min: number, max: number): string {
  // Treat 16+ (our default) as "∞" since the lobby cap is informational.
  const maxStr = max >= 16 ? "∞" : String(max);
  if (min === max) return `${min}`;
  return `${min} – ${maxStr}`;
}

function gamemodeLabel(g: MiniGameInfo["gamemode"]): string {
  if (g === "tournament") return "Tournament";
  if (g === "last-man-standing") return "Last One Standing";
  return g;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
