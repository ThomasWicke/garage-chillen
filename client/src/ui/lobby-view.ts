// DOM rendering for the lobby (idle state). Shows the player list, GM
// controls (Select Game / Shuffle), and the shuffle-sequence status panel
// when a sequence is running.
//
// Each player's own row is editable when the lobby is "calm" (idle and
// no sequence running, or sequence paused): tap the avatar to cycle to the
// next available one; click the name (pen icon shown) to rename.

import { starData } from "@kaplayjs/crew";
import { avatarSrc } from "../identity";
import type {
  MiniGameInfo,
  PublicPlayer,
  SequencePublicState,
} from "../../../party/protocol";

const STAR_SRC = starData.kind === "Sprite" ? starData.outlined : "";

export type LobbyViewState = {
  selfPlayerId: string | null;
  players: PublicPlayer[];
  gmPlayerId: string | null;
  availableMinigames: MiniGameInfo[];
  sequence?: SequencePublicState;
  /** True when the player can edit their own avatar/name right now. */
  editable: boolean;
  /** Inline error to surface above the player row (e.g. "name already taken"). */
  editError?: { field: "nickname" | "avatar"; reason: string } | null;
  /** Set when the user is currently editing their nickname inline. */
  editingNickname?: boolean;
  /** The current draft nickname while editing — preserved across rerenders. */
  nicknameDraft?: string;
};

export type LobbyViewHandlers = {
  onPickMinigame: () => void; // open drawer
  onStartShuffle: () => void;
  onPauseSequence: () => void;
  onResumeSequence: () => void;
  onEndSequence: () => void;
  onCycleAvatar: () => void;
  /** Begin nickname edit (state-only; no wire effect). */
  onBeginEditNickname: () => void;
  /** Update the local draft nickname (state-only). */
  onDraftNickname: (value: string) => void;
  /** Commit the draft nickname (sends set-nickname). The current input value
   *  is passed so the handler doesn't depend on race-prone state syncing. */
  onCommitNickname: (value: string) => void;
  /** Cancel nickname edit (drops the draft). */
  onCancelNickname: () => void;
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
            : s.players.map((p) => renderPlayer(p, s)).join("")
        }
      </div>
      ${
        s.editError
          ? `<div class="edit-error">${escapeHtml(s.editError.reason)}</div>`
          : ""
      }
      <div class="gm-controls">
        ${renderControls(s, isSelfGm, connectedCount)}
      </div>
    </div>
  `;

  const root = container;

  // GM controls.
  const pickBtn = root.querySelector<HTMLButtonElement>("[data-action='pick-minigame']");
  pickBtn?.addEventListener("click", () => handlers.onPickMinigame());
  const shuffleBtn = root.querySelector<HTMLButtonElement>("[data-action='start-shuffle']");
  shuffleBtn?.addEventListener("click", () => handlers.onStartShuffle());
  const pauseBtn = root.querySelector<HTMLButtonElement>("[data-action='pause-sequence']");
  pauseBtn?.addEventListener("click", () => handlers.onPauseSequence());
  const resumeBtn = root.querySelector<HTMLButtonElement>("[data-action='resume-sequence']");
  resumeBtn?.addEventListener("click", () => handlers.onResumeSequence());
  const endBtn = root.querySelector<HTMLButtonElement>("[data-action='end-sequence']");
  endBtn?.addEventListener("click", () => handlers.onEndSequence());

  // Self-edit affordances.
  const selfRow = root.querySelector<HTMLElement>(".player.self");
  if (selfRow && s.editable) {
    const avatarEl = selfRow.querySelector<HTMLElement>(".avatar");
    avatarEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onCycleAvatar();
    });
    const nameEl = selfRow.querySelector<HTMLElement>("[data-edit-name]");
    nameEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onBeginEditNickname();
    });
    const input = selfRow.querySelector<HTMLInputElement>("[data-name-input]");
    if (input) {
      // Focus synchronously inside the user-gesture call stack — iOS only
      // pops the keyboard for focus calls that happen during the gesture.
      // setTimeout(0) defers to a later macrotask and would break that.
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener("input", () => {
        // Sync draft into state so an external force-commit (e.g. lobby
        // state change) sees the latest typed value.
        handlers.onDraftNickname(input.value);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handlers.onCommitNickname(input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          handlers.onCancelNickname();
        }
      });
      // On mobile the keyboard "Done" button blurs the input (and on some
      // keyboards never sends Enter). Treating blur as "commit current
      // value" matches what the user expects from tapping Done or tapping
      // anywhere outside the field.
      input.addEventListener("blur", () => {
        handlers.onCommitNickname(input.value);
      });
    }
  }
}

function renderControls(
  s: LobbyViewState,
  isSelfGm: boolean,
  connectedCount: number,
): string {
  if (s.sequence) {
    return renderSequencePanel(s, s.sequence, isSelfGm);
  }
  if (!isSelfGm) return "";
  const someEligible = s.availableMinigames.some(
    (m) => connectedCount >= m.minPlayers && connectedCount <= m.maxPlayers,
  );
  const hasGames = s.availableMinigames.length > 0;
  const canShuffle = hasGames && someEligible;
  return `
    <div class="gm-actions">
      <button class="primary mg-btn" data-action="pick-minigame" ${hasGames ? "" : "disabled"}>
        <span class="mg-name">Select Game</span>
      </button>
      <button class="primary mg-btn" data-action="start-shuffle" ${canShuffle ? "" : "disabled"}>
        <span class="mg-name">Shuffle</span>
      </button>
    </div>
  `;
}

function renderSequencePanel(
  s: LobbyViewState,
  seq: SequencePublicState,
  isSelfGm: boolean,
): string {
  const total = seq.total;
  const completed = total - seq.remaining;
  const nextLabel = seq.nextMinigameId
    ? (s.availableMinigames.find((m) => m.id === seq.nextMinigameId)?.displayName ??
       seq.nextMinigameId)
    : "—";
  const countdownSec =
    seq.autoStartAt !== null
      ? Math.max(0, Math.ceil((seq.autoStartAt - Date.now()) / 1000))
      : null;

  let statusLine = "";
  if (seq.paused) {
    statusLine = `<div class="seq-status paused">Sequence paused</div>`;
  } else if (countdownSec !== null) {
    statusLine = `
      <div class="seq-status">Next round in</div>
      <div class="seq-countdown">${countdownSec}</div>
    `;
  } else if (seq.remaining > 0) {
    statusLine = `<div class="seq-status">Round in progress…</div>`;
  } else {
    statusLine = `<div class="seq-status">Sequence complete</div>`;
  }

  let nextBlock = "";
  if (seq.nextMinigameId && !seq.paused) {
    nextBlock = `<div class="seq-next">Next: <strong>${escapeHtml(nextLabel)}</strong></div>`;
  } else if (seq.nextMinigameId && seq.paused) {
    nextBlock = `<div class="seq-next">Up next: <strong>${escapeHtml(nextLabel)}</strong></div>`;
  }

  let gmBtns = "";
  if (isSelfGm) {
    if (seq.paused) {
      gmBtns = `
        <div class="seq-actions">
          <button class="primary mg-btn" data-action="resume-sequence">Continue</button>
          <button class="secondary mg-btn" data-action="end-sequence">End</button>
        </div>
      `;
    } else if (seq.remaining > 0) {
      gmBtns = `
        <div class="seq-actions">
          <button class="secondary mg-btn" data-action="pause-sequence">Pause</button>
          <button class="secondary mg-btn" data-action="end-sequence">End</button>
        </div>
      `;
    } else {
      gmBtns = `
        <div class="seq-actions">
          <button class="secondary mg-btn" data-action="end-sequence">Close</button>
        </div>
      `;
    }
  }

  return `
    <div class="sequence-panel">
      <div class="seq-progress">
        <span class="seq-pill">Shuffle</span>
        <span class="seq-progress-text">Round ${Math.min(completed + 1, total)} of ${total}</span>
      </div>
      ${statusLine}
      ${nextBlock}
      ${gmBtns}
    </div>
  `;
}

function renderPlayer(p: PublicPlayer, s: LobbyViewState): string {
  const isSelf = !!s.selfPlayerId && p.playerId === s.selfPlayerId;
  const editable = isSelf && s.editable;
  const classes = ["player"];
  if (p.isGm) classes.push("gm");
  if (isSelf) classes.push("self");
  if (!p.connected) classes.push("disconnected");
  if (editable) classes.push("editable");

  const avatarEl = `<span class="avatar"><img src="${avatarSrc(p.avatarId)}" alt="" /></span>`;

  // Editable nickname slot. While editing, render an <input>; otherwise a
  // span (with a pen icon when editable).
  let nameSlot: string;
  if (isSelf && s.editingNickname) {
    const draft = s.nicknameDraft ?? p.nickname;
    nameSlot = `
      <span class="name name-edit">
        <input
          type="text"
          maxlength="16"
          data-name-input
          value="${escapeHtml(draft)}"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </span>
    `;
  } else if (editable) {
    nameSlot = `
      <span class="name editable" data-edit-name>
        ${escapeHtml(p.nickname)}
        <span class="pen-icon" aria-hidden="true">✎</span>
      </span>
    `;
  } else {
    nameSlot = `<span class="name">${escapeHtml(p.nickname)}</span>`;
  }

  return `
    <div class="${classes.join(" ")}">
      ${avatarEl}
      ${nameSlot}
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
