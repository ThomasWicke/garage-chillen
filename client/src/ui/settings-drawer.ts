// Host settings drawer (bottom sheet, same shell as the game picker).
//
//   Tutorial  — fast / slow / paused (how the pre-match instruction shows)
//   Shuffle   — every game with a 0–5 frequency stepper: how many copies go
//               into the Shuffle pool (0 = never). Archived games start at 0
//               but can be switched on here.
//
// Every change is sent immediately (the server merges + broadcasts); the
// drawer keeps its own working copy so taps feel instant.

import {
  DEFAULT_LOBBY_SETTINGS,
  SHUFFLE_WEIGHT_MAX,
  TUTORIAL_STYLES,
  effectiveShuffleWeight,
  type LobbySettings,
  type MiniGameInfo,
  type TutorialStyle,
} from "../../../party/protocol";

export type SettingsDrawerProps = {
  minigames: MiniGameInfo[];
  settings: LobbySettings;
  onChange: (partial: Partial<LobbySettings>) => void;
  onClose: () => void;
};

const TUTORIAL_LABEL: Record<TutorialStyle, { name: string; desc: string }> = {
  fast: { name: "Fast", desc: "hint + 3-2-1-GO (3s)" },
  slow: { name: "Slow", desc: "hint + countdown, 7s" },
  paused: {
    name: "Paused",
    desc: "hint stays up until you tap START, then 3-2-1-GO",
  },
};

export function openSettingsDrawer(props: SettingsDrawerProps): () => void {
  // Working copy.
  const settings: LobbySettings = {
    shuffleWeights: { ...props.settings.shuffleWeights },
    tutorial: props.settings.tutorial,
  };

  const overlay = document.createElement("div");
  overlay.className = "drawer-overlay";
  overlay.innerHTML = `
    <div class="drawer-sheet" role="dialog" aria-label="Lobby settings">
      <div class="drawer-handle"></div>
      <div class="drawer-header">
        <div class="drawer-title">Lobby settings</div>
        <button class="drawer-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="settings-body" id="settings-body"></div>
    </div>
  `;
  const sheet = overlay.querySelector<HTMLElement>(".drawer-sheet")!;
  const body = overlay.querySelector<HTMLElement>("#settings-body")!;
  const closeBtn = overlay.querySelector<HTMLButtonElement>(".drawer-close")!;

  function poolSize(): number {
    return props.minigames.reduce(
      (n, m) => n + effectiveShuffleWeight(m, settings),
      0,
    );
  }

  function render() {
    const games = [...props.minigames].sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return a.displayName.localeCompare(b.displayName);
    });
    const included = games.filter((m) => effectiveShuffleWeight(m, settings) > 0).length;
    body.innerHTML = `
      <div class="settings-section">
        <div class="settings-heading">Tutorial</div>
        <div class="settings-sub">how the instruction shows before each game</div>
        <div class="settings-pills">
          ${TUTORIAL_STYLES.map(
            (t) => `<button class="settings-pill ${settings.tutorial === t ? "on" : ""}" data-tutorial="${t}" type="button">
              <span class="settings-pill-name">${TUTORIAL_LABEL[t].name}</span>
              <span class="settings-pill-desc">${TUTORIAL_LABEL[t].desc}</span>
            </button>`,
          ).join("")}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-heading">Shuffle</div>
        <div class="settings-sub">how often each game comes up · ${included}/${games.length} games in, ${poolSize()} slots in the pool</div>
        <div class="settings-games">
          ${games.map((m) => renderGameRow(m)).join("")}
        </div>
        <button class="settings-reset" data-action="reset-weights" type="button">reset frequencies to defaults</button>
      </div>
    `;

    body.querySelectorAll<HTMLButtonElement>("[data-tutorial]").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tutorial as TutorialStyle;
        if (t === settings.tutorial) return;
        settings.tutorial = t;
        props.onChange({ tutorial: t });
        render();
      });
    });
    body.querySelectorAll<HTMLButtonElement>("[data-weight-delta]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.dataset.game!;
        const delta = Number(b.dataset.weightDelta);
        const m = props.minigames.find((g) => g.id === id);
        if (!m) return;
        const cur = effectiveShuffleWeight(m, settings);
        const next = Math.max(0, Math.min(SHUFFLE_WEIGHT_MAX, cur + delta));
        if (next === cur) return;
        settings.shuffleWeights = { ...settings.shuffleWeights, [id]: next };
        props.onChange({ shuffleWeights: settings.shuffleWeights });
        render();
      });
    });
    body
      .querySelector<HTMLButtonElement>("[data-action='reset-weights']")
      ?.addEventListener("click", () => {
        settings.shuffleWeights = { ...DEFAULT_LOBBY_SETTINGS.shuffleWeights };
        props.onChange({ shuffleWeights: settings.shuffleWeights });
        render();
      });
  }

  function renderGameRow(m: MiniGameInfo): string {
    const w = effectiveShuffleWeight(m, settings);
    const def = m.archived ? 0 : m.shuffleWeight;
    const dots = Array.from({ length: SHUFFLE_WEIGHT_MAX }, (_, i) =>
      `<span class="settings-dot ${i < w ? "on" : ""}"></span>`,
    ).join("");
    return `
      <div class="settings-game ${w === 0 ? "off" : ""}">
        <div class="settings-game-name">
          ${escapeHtml(m.displayName)}
          ${m.archived ? `<span class="settings-tag">archive</span>` : ""}
          ${w !== def ? `<span class="settings-tag changed">default ${def}</span>` : ""}
        </div>
        <div class="settings-stepper">
          <button type="button" data-game="${escapeHtml(m.id)}" data-weight-delta="-1" ${w === 0 ? "disabled" : ""} aria-label="less often">−</button>
          <span class="settings-dots" title="${w} of ${SHUFFLE_WEIGHT_MAX}">${dots}</span>
          <button type="button" data-game="${escapeHtml(m.id)}" data-weight-delta="1" ${w >= SHUFFLE_WEIGHT_MAX ? "disabled" : ""} aria-label="more often">+</button>
        </div>
      </div>
    `;
  }

  render();

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
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  sheet.offsetHeight; // reflow so the open transition runs
  sheet.classList.add("open");
  overlay.classList.add("open");

  return close;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
