// Start screen: pick nickname + avatar, then create a lobby or join one by code.

import { AVATARS, ensureIdentity, saveIdentity } from "../identity";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1
const CODE_LENGTH = 4;

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function renderStart(navigate: (path: string) => void): void {
  const identity = ensureIdentity();
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="start">
      <div class="header">
        <div class="title">Garage <span class="accent">chillen</span></div>
        <div class="subtitle">multiplayer party games</div>
      </div>
      <div class="profile">
        <div>
          <label for="nickname">Nickname</label>
          <input id="nickname" type="text" maxlength="16" placeholder="your name" value="${escapeAttr(identity.nickname)}" autocomplete="off" autocapitalize="words" spellcheck="false" style="width: 100%; box-sizing: border-box; margin-top: 8px;" />
        </div>
        <div>
          <label>Avatar</label>
          <div class="avatar-row" id="avatar-row" style="margin-top: 8px;">
            ${AVATARS.map(
              (a) => `
              <button class="avatar ${a.id === identity.avatarId ? "selected" : ""}" data-avatar="${a.id}" type="button">${a.emoji}</button>
            `,
            ).join("")}
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="create-btn">Create lobby</button>
        <div class="or">or</div>
        <form class="join-form" id="join-form">
          <input id="join-code" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="${CODE_LENGTH}" placeholder="CODE" />
          <button type="submit">Join</button>
        </form>
      </div>
    </div>
  `;

  const nicknameInput = document.getElementById("nickname") as HTMLInputElement;
  nicknameInput.addEventListener("input", () => {
    identity.nickname = nicknameInput.value;
    saveIdentity(identity);
  });

  const avatarRow = document.getElementById("avatar-row")!;
  avatarRow.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-avatar]") as
      | HTMLElement
      | null;
    if (!target) return;
    const avatarId = target.dataset.avatar!;
    identity.avatarId = avatarId;
    saveIdentity(identity);
    avatarRow
      .querySelectorAll(".avatar")
      .forEach((el) => el.classList.toggle("selected", (el as HTMLElement).dataset.avatar === avatarId));
  });

  const codeInput = document.getElementById("join-code") as HTMLInputElement;
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, CODE_LENGTH);
  });

  const createBtn = document.getElementById("create-btn") as HTMLButtonElement;
  createBtn.addEventListener("click", () => {
    if (!identity.nickname.trim()) {
      nicknameInput.focus();
      return;
    }
    navigate(`/lobby/${generateCode()}`);
  });

  const joinForm = document.getElementById("join-form") as HTMLFormElement;
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (code.length !== CODE_LENGTH) return;
    if (!identity.nickname.trim()) {
      nicknameInput.focus();
      return;
    }
    navigate(`/lobby/${code}`);
  });
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
