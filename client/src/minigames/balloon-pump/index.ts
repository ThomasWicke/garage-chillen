// Balloon Pump client. Pure DOM. Your own balloon is front-and-center and
// grows with every pump; everyone else's balloons inflate live in a grid
// below (avatar + swelling balloon + pump count), so the whole lobby sweats
// together. Two big buttons: PUMP (+1, risk the pop) and BANK (lock in the
// round points). Pops get a big 💥 animation; round results overlay each
// player's +N / POP for 3s between rounds.

import { avatarSrc } from "../../identity";
import { formatRemaining, statusLine } from "../clock";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Status = "pumping" | "banked" | "popped";
type Phase = "pumping" | "round-results" | "ended";

type WelcomeMsg = {
  type: "welcome";
  rounds: number;
  roundMs: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
  deadlineAt: number;
};

type PlayerWire = {
  status: Status;
  pumps: number;
  roundPoints: number;
  total: number;
  left: boolean;
};

type StateMsg = {
  type: "state";
  phase: Phase;
  round: number;
  roundEndsAt: number;
  resultsUntil: number;
  players: Record<string, PlayerWire>;
  deadlineAt: number;
};

function createBalloonPumpMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="bp">
      <style>
        .bp {
          position: relative; width: 100%; height: 100%;
          background: #0a0a14; color: #f2f2f5;
          display: flex; flex-direction: column;
          font-family: inherit; overflow: hidden;
        }
        .bp-banner {
          padding: 8px 10px; text-align: center; font-size: 14px;
          color: #9a9aa5; min-height: 22px;
        }
        .bp-own {
          flex: 1 1 auto; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 8px;
          min-height: 0;
        }
        .bp-own-wrap {
          position: relative; display: flex; align-items: center;
          justify-content: center; width: 260px; height: 260px;
        }
        .bp-balloon {
          border-radius: 50% 50% 50% 50% / 46% 46% 54% 54%;
          background: radial-gradient(circle at 35% 30%, #ff9db0, #ff5a76 65%, #d13a55);
          display: flex; align-items: center; justify-content: center;
          transition: width 0.12s ease-out, height 0.12s ease-out, background 0.2s;
          font-size: 28px; font-weight: 800; color: #0a0a14;
        }
        .bp-own.banked .bp-balloon {
          background: radial-gradient(circle at 35% 30%, #d3f0a4, #abdd64 65%, #7fb03e);
        }
        .bp-own.popped .bp-balloon { display: none; }
        .bp-own-boom {
          position: absolute; inset: 0; display: none;
          align-items: center; justify-content: center; font-size: 96px;
        }
        .bp-own.popped .bp-own-boom { display: flex; animation: bp-pop 0.5s ease-out; }
        @keyframes bp-pop {
          0% { transform: scale(0.2); opacity: 0.4; }
          60% { transform: scale(1.35); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .bp-own-label { font-size: 14px; color: #9a9aa5; min-height: 18px; }
        .bp-grid {
          display: grid; grid-template-columns: repeat(4, 1fr);
          gap: 6px; padding: 6px 8px; overflow-y: auto;
          max-height: 32%; flex: 0 0 auto;
        }
        .bp-cell {
          position: relative; display: flex; flex-direction: column;
          align-items: center; gap: 2px; padding: 4px 2px;
          background: #12121f; border: 1px solid #22222f;
          border-radius: 10px; min-height: 96px; justify-content: flex-end;
        }
        .bp-cell img { width: 22px; height: 22px; border-radius: 50%; }
        .bp-mini {
          flex: 1; display: flex; align-items: flex-end; justify-content: center;
          position: relative; width: 100%;
        }
        .bp-mini-balloon {
          border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #ff9db0, #ff5a76 70%);
          transition: width 0.12s ease-out, height 0.12s ease-out;
        }
        .bp-cell.banked .bp-mini-balloon {
          background: radial-gradient(circle at 35% 30%, #d3f0a4, #abdd64 70%);
        }
        .bp-cell.popped .bp-mini-balloon { display: none; }
        .bp-cell.left { opacity: 0.35; }
        .bp-mini-boom {
          position: absolute; inset: 0; display: none;
          align-items: center; justify-content: center; font-size: 28px;
        }
        .bp-cell.popped .bp-mini-boom { display: flex; animation: bp-pop 0.5s ease-out; }
        .bp-cnick {
          font-size: 10px; color: #9a9aa5; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .bp-cell.self .bp-cnick { color: #abdd64; font-weight: 700; }
        .bp-cbadge { font-size: 12px; font-weight: 700; min-height: 15px; }
        .bp-cell.popped .bp-cbadge { color: #ff5a76; }
        .bp-cell.banked .bp-cbadge { color: #abdd64; }
        .bp-buttons {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
          padding: 8px 10px calc(10px + env(safe-area-inset-bottom, 0px));
          flex: 0 0 auto;
        }
        .bp-btn {
          min-height: 64px; border-radius: 14px; border: none;
          font-size: 22px; font-weight: 800; letter-spacing: 1px;
          touch-action: manipulation; -webkit-tap-highlight-color: transparent;
        }
        .bp-btn:disabled { opacity: 0.35; }
        .bp-btn-pump { background: #ff5a76; color: #0a0a14; }
        .bp-btn-bank { background: #abdd64; color: #0a0a14; }
        .bp-btn:active:not(:disabled) { transform: scale(0.97); }
      </style>
      <div class="bp-banner" id="bp-banner">connecting…</div>
      <div class="bp-own" id="bp-own">
        <div class="bp-own-wrap">
          <div class="bp-balloon" id="bp-balloon">0</div>
          <div class="bp-own-boom">💥</div>
        </div>
        <div class="bp-own-label" id="bp-own-label"></div>
      </div>
      <div class="bp-grid" id="bp-grid"></div>
      <div class="bp-buttons" id="bp-buttons">
        <button class="bp-btn bp-btn-pump" id="bp-pump" type="button">PUMP</button>
        <button class="bp-btn bp-btn-bank" id="bp-bank" type="button">BANK</button>
      </div>
    </div>
  `;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#bp-banner")!;
  const ownEl = ctx.container.querySelector<HTMLElement>("#bp-own")!;
  const balloonEl = ctx.container.querySelector<HTMLElement>("#bp-balloon")!;
  const ownLabelEl = ctx.container.querySelector<HTMLElement>("#bp-own-label")!;
  const gridEl = ctx.container.querySelector<HTMLElement>("#bp-grid")!;
  const buttonsEl = ctx.container.querySelector<HTMLElement>("#bp-buttons")!;
  const pumpBtn = ctx.container.querySelector<HTMLButtonElement>("#bp-pump")!;
  const bankBtn = ctx.container.querySelector<HTMLButtonElement>("#bp-bank")!;

  let players: WelcomeMsg["players"] = [];
  let rounds = 3;
  let built = false;
  let selfIsPlayer = false;
  const cellByPid = new Map<string, HTMLElement>();
  const prevStatus = new Map<string, Status>();
  let prevRound = 0;

  let lastTapAt = 0;
  function bindTap(btn: HTMLButtonElement, type: "pump" | "bank") {
    const tap = (e: Event) => {
      if (ctx.isSpectator) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      const now = Date.now();
      if (now - lastTapAt < 80) return;
      lastTapAt = now;
      ctx.send({ type });
    };
    btn.addEventListener("touchstart", tap, { passive: false });
    btn.addEventListener("mousedown", tap);
  }
  bindTap(pumpBtn, "pump");
  bindTap(bankBtn, "bank");

  function buildGrid() {
    // Own balloon is front-and-center; the grid shows the OTHERS. Spectators
    // (not in the roster) get everyone in the grid instead.
    const gridPlayers = selfIsPlayer
      ? players.filter((p) => p.playerId !== ctx.selfPlayerId)
      : players;
    gridEl.innerHTML = gridPlayers
      .map(
        (p) => `<div class="bp-cell${p.playerId === ctx.selfPlayerId ? " self" : ""}" data-pid="${escapeHtml(p.playerId)}">
          <div class="bp-mini">
            <div class="bp-mini-balloon" style="width:16px;height:16px"></div>
            <div class="bp-mini-boom">💥</div>
          </div>
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <div class="bp-cnick">${escapeHtml(p.nickname)}</div>
          <div class="bp-cbadge">0</div>
        </div>`,
      )
      .join("");
    cellByPid.clear();
    gridEl.querySelectorAll<HTMLElement>(".bp-cell").forEach((el) => {
      cellByPid.set(el.dataset.pid!, el);
    });
  }

  function applyWelcome(msg: WelcomeMsg) {
    // Rebuild-safe: the cached welcome is replayed on reconnect — build once.
    if (built) return;
    built = true;
    players = msg.players;
    rounds = msg.rounds;
    selfIsPlayer = players.some((p) => p.playerId === ctx.selfPlayerId);
    if (!selfIsPlayer || ctx.isSpectator) {
      ownEl.style.display = "none";
      buttonsEl.style.display = "none";
    }
    buildGrid();
    bannerEl.textContent = "pump it up — bank before it pops!";
  }

  function applyState(msg: StateMsg) {
    if (!built) return; // never assume welcome arrived first
    const now = Date.now();
    const results = msg.phase === "round-results";

    // Round change: forget pop states so animations can re-fire next round.
    if (msg.round !== prevRound) {
      prevRound = msg.round;
      prevStatus.clear();
    }

    // --- Own balloon ---
    const me = msg.players[ctx.selfPlayerId];
    if (me && selfIsPlayer && !ctx.isSpectator) {
      const size = Math.min(240, 70 + me.pumps * 8);
      balloonEl.style.width = `${size}px`;
      balloonEl.style.height = `${size}px`;
      balloonEl.textContent = String(me.pumps);
      ownEl.classList.toggle("popped", me.status === "popped");
      ownEl.classList.toggle("banked", me.status === "banked");
      if (results) {
        ownLabelEl.textContent =
          me.status === "popped"
            ? "POPPED · +0 this round"
            : `banked +${me.roundPoints}`;
      } else if (me.status === "popped") {
        ownLabelEl.textContent = "POPPED! · watch the others";
      } else if (me.status === "banked") {
        ownLabelEl.textContent = `banked +${me.roundPoints} · watch the others`;
      } else {
        ownLabelEl.textContent = "PUMP to inflate · BANK to keep";
      }
      const canAct = msg.phase === "pumping" && me.status === "pumping" && !me.left;
      pumpBtn.disabled = !canAct;
      bankBtn.disabled = !canAct || me.pumps === 0;
    }

    // --- Grid ---
    for (const [pid, cell] of cellByPid) {
      const s = msg.players[pid];
      if (!s) continue;
      cell.classList.toggle("left", s.left);
      cell.classList.toggle("banked", s.status === "banked" && !s.left);
      // Toggling the class re-triggers the 💥 animation only on transition.
      const wasPopped = prevStatus.get(pid) === "popped";
      cell.classList.toggle("popped", s.status === "popped");
      if (s.status === "popped" && !wasPopped) {
        const boom = cell.querySelector<HTMLElement>(".bp-mini-boom")!;
        boom.style.animation = "none";
        void boom.offsetWidth;
        boom.style.animation = "";
      }
      const mini = cell.querySelector<HTMLElement>(".bp-mini-balloon")!;
      const mSize = Math.min(56, 16 + s.pumps * 2);
      mini.style.width = `${mSize}px`;
      mini.style.height = `${mSize}px`;
      const badge = cell.querySelector<HTMLElement>(".bp-cbadge")!;
      if (s.left) badge.textContent = "gone";
      else if (results)
        badge.textContent = s.status === "popped" ? "POP" : `+${s.roundPoints}`;
      else if (s.status === "popped") badge.textContent = "POP";
      else if (s.status === "banked") badge.textContent = `✓${s.roundPoints}`;
      else badge.textContent = String(s.pumps);
    }
    for (const [pid, s] of Object.entries(msg.players)) {
      prevStatus.set(pid, s.status);
    }

    // --- Banner / toolbar ---
    const clock = formatRemaining(msg.deadlineAt);
    if (results) {
      bannerEl.textContent = statusLine(
        `round ${msg.round}/${rounds} over`,
        msg.round >= rounds ? "final results…" : "next round…",
        clock,
      );
    } else {
      const secs = Math.max(0, Math.ceil((msg.roundEndsAt - now) / 1000));
      bannerEl.textContent = statusLine(
        `round ${msg.round}/${rounds}`,
        `${secs}s`,
        clock,
      );
    }
    ctx.setMatchScore(me ? `${me.total} pts` : "spectating");
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const BalloonPumpClient: MiniGameClientDefinition = {
  id: "balloon-pump",
  controlsHint: "PUMP to inflate · BANK before it pops — 3 rounds, most points wins",
  createMatch: createBalloonPumpMatchClient,
};

registerMiniGameClient(BalloonPumpClient);

export default BalloonPumpClient;
