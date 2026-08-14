// Brief splash between "GM clicked Start" and "round begins". Deliberately
// NO countdown number — with a timer it read as a third waiting screen; as a
// plain name splash it's just an intro flash (the gamemode intro right after
// carries the countdown).

import type { MiniGameInfo } from "../../../party/protocol";

export function renderPreparingView(
  args: {
    minigame: MiniGameInfo | null;
    countdownEndsAt: number;
  },
  container: HTMLElement,
): void {
  container.innerHTML = `
    <div class="preparing">
      <div class="preparing-name">${args.minigame?.displayName ?? "starting"}</div>
    </div>
  `;
}
