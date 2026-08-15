// Tutorial style "paused": the gamemode intro is held until the host taps
// START. Both gamemode clients render this block below their intro header:
// the mini-game's controls hint (frozen — no countdown), and either the START
// button (host) or a "waiting for the host" line (everyone else). Tapping
// START sends `tutorial-start` on the gamemode channel; the server only
// honours it from the host.

export function heldIntroHtml(hint: string | null, isGm: boolean): string {
  return `
    <div class="held-intro">
      ${hint ? `<div class="held-intro-hint">${escapeHtml(hint)}</div>` : ""}
      ${
        isGm
          ? `<button class="primary held-intro-start" data-action="tutorial-start" type="button">START</button>
             <div class="held-intro-note">explain the rules, then tap START — 3-2-1-GO follows</div>`
          : `<div class="held-intro-note">the host is explaining the rules — starts when they tap START</div>`
      }
    </div>
  `;
}

export function bindHeldIntro(
  root: HTMLElement,
  onStart: () => void,
): void {
  root
    .querySelector<HTMLButtonElement>("[data-action='tutorial-start']")
    ?.addEventListener("click", onStart);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
