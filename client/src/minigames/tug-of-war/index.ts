// Tug of War client. DOM-based portrait scene: a vertical rope with the
// knot marker, opponent avatar at the top, own avatar at the bottom, and a
// giant PULL button covering the bottom 40% of the screen.
//
// The wire knot is canonical: + toward p1, - toward p2. Each client renders
// with THEIR side at the bottom, so p2 (and only p2) flips the sign:
//   viewKnot = role === "p2" ? -knot : knot
// Concrete trace: p2 taps once → server knot = -4 (toward p2).
//   On p2's phone:  viewKnot = -(-4) = +4 → marker moves toward the BOTTOM
//     (p2's own side) — correct, p2's pull dragged the knot toward p2.
//   On p1's phone:  viewKnot = -4 → marker moves toward the TOP (opponent
//     side) — also correct.
// At viewKnot = +100 the marker sits on the bottom avatar = "pulled fully
// to YOUR side" = you win. Spectators see the canonical view (p1 bottom).

import { avatarSrc } from "../../identity";
import { formatRemaining, statusLine } from "../clock";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Role = "p1" | "p2" | "spectator";

type WirePlayer = { playerId: string; nickname: string; avatarId: string };

type WelcomeMsg = {
  type: "welcome";
  range: number;
  pullStep: number;
  deadlineAt: number;
  players: { p1: WirePlayer; p2: WirePlayer };
};

type StateMsg = {
  type: "state";
  knot: number;
  pulls: { p1: number; p2: number };
  deadlineAt: number;
};

function createTugOfWarMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="tug">
      <style>
        .tug {
          position: relative; width: 100%; height: 100%;
          display: flex; flex-direction: column;
          background: #0a0a14; color: #f2f2f5; overflow: hidden;
          font-family: inherit; user-select: none; -webkit-user-select: none;
        }
        .tug-tint {
          position: absolute; inset: 0; pointer-events: none; opacity: 0;
          transition: opacity 120ms linear; z-index: 0;
        }
        .tug-tint-win { background: linear-gradient(to top, rgba(171,221,100,0.55), transparent 65%); }
        .tug-tint-lose { background: linear-gradient(to bottom, rgba(221,100,100,0.55), transparent 65%); }
        .tug-arena {
          position: relative; flex: 1 1 60%; min-height: 0; z-index: 1;
          display: flex; flex-direction: column; align-items: center;
          padding: 8px 0 4px;
        }
        .tug-end {
          display: flex; flex-direction: column; align-items: center; gap: 2px;
          flex: 0 0 auto; z-index: 2;
        }
        .tug-end img {
          width: 56px; height: 56px; border-radius: 50%;
          border: 2px solid #9a9aa5; background: #1a1a28;
        }
        .tug-end.tug-self img { border-color: #abdd64; }
        .tug-nick { font-size: 13px; color: #9a9aa5; max-width: 120px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tug-end.tug-self .tug-nick { color: #abdd64; font-weight: 700; }
        .tug-ropewrap { position: relative; flex: 1 1 auto; width: 100%; min-height: 0; }
        .tug-rope {
          position: absolute; left: 50%; top: 0; bottom: 0; width: 10px;
          transform: translateX(-50%); border-radius: 5px;
          background: repeating-linear-gradient(
            -35deg, #a5793f 0 8px, #8a6230 8px 16px);
        }
        .tug-knot {
          position: absolute; left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          width: 44px; height: 26px; border-radius: 13px;
          background: #e6533c; border: 3px solid #f2f2f5;
          box-shadow: 0 0 12px rgba(230, 83, 60, 0.7);
          transition: top 90ms linear;
          z-index: 3;
        }
        .tug-midline {
          position: absolute; left: 12%; right: 12%; top: 50%; height: 0;
          border-top: 2px dashed #3a3a50;
        }
        .tug-status {
          flex: 0 0 auto; text-align: center; font-size: 14px;
          color: #9a9aa5; padding: 4px 8px; z-index: 1;
        }
        .tug-pull {
          flex: 0 0 40%; margin: 0 12px 12px; z-index: 1;
          border: none; border-radius: 20px;
          background: #abdd64; color: #0a0a14;
          font-size: 44px; font-weight: 900; letter-spacing: 2px;
          touch-action: manipulation; cursor: pointer;
        }
        .tug-pull:active { filter: brightness(1.1); }
        .tug-pull.tug-pulse { animation: tug-pulse 160ms ease-out; }
        @keyframes tug-pulse {
          0% { transform: scale(1); }
          40% { transform: scale(0.94); }
          100% { transform: scale(1); }
        }
      </style>
      <div class="tug-tint tug-tint-win" id="tug-tint-win"></div>
      <div class="tug-tint tug-tint-lose" id="tug-tint-lose"></div>
      <div class="tug-arena">
        <div class="tug-end" id="tug-end-top">
          <img id="tug-avatar-top" alt="" />
          <div class="tug-nick" id="tug-nick-top"></div>
        </div>
        <div class="tug-ropewrap">
          <div class="tug-midline"></div>
          <div class="tug-rope"></div>
          <div class="tug-knot" id="tug-knot"></div>
        </div>
        <div class="tug-end tug-self" id="tug-end-bottom">
          <img id="tug-avatar-bottom" alt="" />
          <div class="tug-nick" id="tug-nick-bottom"></div>
        </div>
      </div>
      <div class="tug-status" id="tug-status">connecting…</div>
      <button class="tug-pull" id="tug-pull" type="button">PULL!</button>
    </div>
  `;

  const q = <T extends HTMLElement>(sel: string) =>
    ctx.container.querySelector<T>(sel)!;
  const tintWinEl = q<HTMLElement>("#tug-tint-win");
  const tintLoseEl = q<HTMLElement>("#tug-tint-lose");
  const knotEl = q<HTMLElement>("#tug-knot");
  const statusEl = q<HTMLElement>("#tug-status");
  const pullBtn = q<HTMLButtonElement>("#tug-pull");
  const avatarTop = q<HTMLImageElement>("#tug-avatar-top");
  const avatarBottom = q<HTMLImageElement>("#tug-avatar-bottom");
  const nickTop = q<HTMLElement>("#tug-nick-top");
  const nickBottom = q<HTMLElement>("#tug-nick-bottom");
  const endBottom = q<HTMLElement>("#tug-end-bottom");

  let role: Role | null = null;
  let range = 100;
  let roleHint = "";

  // PULL taps: send on touchstart (instant feel), debounced ~80ms — which
  // also roughly matches the server's 12 taps/sec limit.
  let lastTapAt = 0;
  const tap = (e: Event) => {
    if (ctx.isSpectator || role === "spectator") return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapAt < 80) return;
    lastTapAt = now;
    ctx.send({ type: "pull" });
    // Visible tap feedback: restart the pulse animation.
    pullBtn.classList.remove("tug-pulse");
    void pullBtn.offsetWidth; // reflow to restart the CSS animation
    pullBtn.classList.add("tug-pulse");
  };
  pullBtn.addEventListener("touchstart", tap, { passive: false });
  pullBtn.addEventListener("mousedown", tap);

  function applyWelcome(msg: WelcomeMsg) {
    // Derive own role from the roster (welcome goes to everyone).
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    range = msg.range;

    // Bottom = own side (p1 canonical for spectators), top = the other.
    const bottom = role === "p2" ? msg.players.p2 : msg.players.p1;
    const top = role === "p2" ? msg.players.p1 : msg.players.p2;
    avatarBottom.src = avatarSrc(bottom.avatarId);
    avatarTop.src = avatarSrc(top.avatarId);
    nickBottom.textContent =
      role === "spectator" ? bottom.nickname : `${bottom.nickname} (YOU)`;
    nickTop.textContent = top.nickname;
    if (role === "spectator") {
      endBottom.classList.remove("tug-self");
      pullBtn.hidden = true; // spectators: rope + avatars only, no button
      roleHint = `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`;
    } else {
      pullBtn.hidden = false;
      roleHint = "";
    }
    statusEl.textContent = roleHint;
  }

  function applyState(msg: StateMsg) {
    if (role === null) return; // never assume welcome arrived first
    if (typeof msg.knot !== "number" || !Number.isFinite(msg.knot)) return;

    // Flip so own side is at the bottom (see trace in the header comment).
    const view = role === "p2" ? -msg.knot : msg.knot;
    // view = -range → 0% (top, opponent's side); +range → 100% (bottom, mine).
    const topPct = 50 + (view / range) * 50;
    knotEl.style.top = `${Math.max(0, Math.min(100, topPct))}%`;

    // Progress tint as the knot nears either end.
    tintWinEl.style.opacity = String((Math.max(0, view) / range) * 0.9);
    tintLoseEl.style.opacity = String((Math.max(0, -view) / range) * 0.9);

    ctx.setMatchScore(
      view === 0 ? "dead even" : `${view > 0 ? "+" : ""}${view}`,
    );
    statusEl.textContent = statusLine(
      roleHint,
      formatRemaining(msg.deadlineAt),
    );
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

const TugOfWarClient: MiniGameClientDefinition = {
  id: "tug-of-war",
  controlsHint: "mash PULL to drag the knot to your side!",
  createMatch: createTugOfWarMatchClient,
};

registerMiniGameClient(TugOfWarClient);

export default TugOfWarClient;
