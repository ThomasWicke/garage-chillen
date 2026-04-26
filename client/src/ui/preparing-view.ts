// Brief countdown shown between "GM clicked Start" and "round begins".

import type { MiniGameInfo } from "../../../party/protocol";

export function renderPreparingView(
  args: {
    minigame: MiniGameInfo | null;
    countdownEndsAt: number;
  },
  container: HTMLElement,
): void {
  const remaining = Math.max(
    0,
    Math.ceil((args.countdownEndsAt - Date.now()) / 1000),
  );
  container.innerHTML = `
    <div class="preparing">
      <div class="preparing-name">${args.minigame?.displayName ?? "starting"}</div>
      <div class="preparing-countdown">${remaining}</div>
    </div>
  `;
}
