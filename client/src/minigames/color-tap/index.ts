// Color Tap client. Pure DOM scene. Big colored signal at the top; 4
// colored buttons fill the rest of the screen. Tap the matching color
// during the signal window. Wrong → strike. 3 strikes → eliminated.

import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Color = "red" | "green" | "blue" | "yellow";

type WelcomeMsg = {
  type: "welcome";
  colors: Color[];
  maxStrikes: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  round: number;
  phase: "signal" | "result";
  signalColor: Color;
  signalEndsAt: number;
  resultEndsAt: number;
  players: Record<
    string,
    { strikes: number; eliminated: boolean; responseColor: Color | null }
  >;
};

const COLOR_HEX: Record<Color, string> = {
  red: "#e0524a",
  green: "#67c259",
  blue: "#5a9bd4",
  yellow: "#e7c64a",
};

function createColorTapMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="ct">
      <div class="ct-signal" id="ct-signal"></div>
      <div class="ct-info" id="ct-info">connecting…</div>
      <div class="ct-buttons" id="ct-buttons"></div>
    </div>
  `;
  const signalEl = ctx.container.querySelector<HTMLElement>("#ct-signal")!;
  const infoEl = ctx.container.querySelector<HTMLElement>("#ct-info")!;
  const buttonsEl = ctx.container.querySelector<HTMLElement>("#ct-buttons")!;

  let maxStrikes = 3;
  let lastTapAt = 0;

  function buildButtons(colors: Color[]) {
    buttonsEl.innerHTML = colors
      .map(
        (c) =>
          `<button class="ct-btn" data-color="${c}" style="background:${COLOR_HEX[c]};"></button>`,
      )
      .join("");
    for (const btn of Array.from(buttonsEl.querySelectorAll<HTMLButtonElement>(".ct-btn"))) {
      const color = btn.getAttribute("data-color") as Color;
      const tap = (e: Event) => {
        if (ctx.isSpectator) return;
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        if (now - lastTapAt < 80) return;
        lastTapAt = now;
        ctx.send({ type: "tap-color", color });
      };
      btn.addEventListener("touchstart", tap, { passive: false });
      btn.addEventListener("mousedown", tap);
    }
  }

  function applyWelcome(msg: WelcomeMsg) {
    maxStrikes = msg.maxStrikes;
    buildButtons(msg.colors);
    infoEl.textContent = "match the color";
  }

  function applyState(msg: StateMsg) {
    const me = msg.players[ctx.selfPlayerId];
    if (msg.phase === "signal") {
      signalEl.style.background = COLOR_HEX[msg.signalColor];
      signalEl.classList.remove("dim");
    } else {
      // result phase — dim
      signalEl.style.background = COLOR_HEX[msg.signalColor];
      signalEl.classList.add("dim");
    }

    if (me) {
      if (me.eliminated) {
        infoEl.textContent = "eliminated · spectating";
      } else {
        infoEl.textContent = `strikes: ${"●".repeat(me.strikes)}${"○".repeat(Math.max(0, maxStrikes - me.strikes))}`;
      }
    } else {
      infoEl.textContent = "spectating";
    }

    const aliveCount = Object.values(msg.players).filter((p) => !p.eliminated).length;
    const total = Object.keys(msg.players).length;
    ctx.setMatchScore(`${aliveCount}/${total} alive`);
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      ctx.container.innerHTML = "";
    },
  };
}

const ColorTapClient: MiniGameClientDefinition = {
  id: "color-tap",
  createMatch: createColorTapMatchClient,
};

registerMiniGameClient(ColorTapClient);

export default ColorTapClient;
