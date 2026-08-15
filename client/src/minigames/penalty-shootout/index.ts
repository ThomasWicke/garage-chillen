// Penalty Shootout client. DOM-based portrait scene: a CSS goal mouth
// split into three zones, a role banner ("YOU SHOOT" / "YOU DEFEND"),
// and three big zone buttons. During the reveal the ball (⚽) and the
// keeper's glove (🧤) drop into their zones and GOAL!/SAVED! flashes.
//
// The server hides both choices until the reveal — during "choosing" the
// wire only carries picked-booleans, so there is nothing to peek at here.

import { statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Role = "p1" | "p2" | "spectator";
type Zone = "left" | "center" | "right";
const ZONES: Zone[] = ["left", "center", "right"];

type WirePlayer = { playerId: string; nickname: string; avatarId: string };

type WelcomeMsg = {
  type: "welcome";
  regRounds: number;
  chooseMs: number;
  revealMs: number;
  deadlineAt: number;
  players: { p1: WirePlayer; p2: WirePlayer };
};

type StateMsg = {
  type: "state";
  phase: "choosing" | "reveal" | "ended";
  round: number;
  regRounds: number;
  suddenDeath: boolean;
  shooterId: string;
  keeperId: string;
  goals: { p1: number; p2: number };
  phaseEndsAt: number;
  shooterPicked: boolean;
  keeperPicked: boolean;
  reveal: {
    round: number;
    shooterId: string;
    keeperId: string;
    shooterZone: Zone;
    keeperZone: Zone;
    keeperPicked?: boolean;
    scored: boolean;
  } | null;
  deadlineAt: number;
};

function createPenaltyShootoutMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="ps">
      <style>
        .ps {
          position: relative; width: 100%; height: 100%;
          display: flex; flex-direction: column;
          background: #0a0a14; color: #f2f2f5; overflow: hidden;
          font-family: inherit; user-select: none; -webkit-user-select: none;
        }
        .ps-banner {
          flex: 0 0 auto; text-align: center; font-size: 22px;
          font-weight: 800; padding: 12px 8px 6px; min-height: 34px;
        }
        .ps-banner.ps-shoot { color: #abdd64; }
        .ps-banner.ps-defend { color: #64b5dd; }
        .ps-sub {
          flex: 0 0 auto; text-align: center; font-size: 14px;
          color: #9a9aa5; min-height: 20px; padding: 0 8px;
        }
        .ps-pitch {
          flex: 1 1 auto; min-height: 0; position: relative;
          display: flex; align-items: center; justify-content: center;
          padding: 14px 10px;
          background: linear-gradient(to bottom, #123018 0%, #1a4020 100%);
        }
        .ps-goal {
          position: relative; width: min(92%, 420px); height: 78%;
          border: 7px solid #f2f2f5; border-bottom: none;
          border-radius: 4px 4px 0 0;
          background:
            repeating-linear-gradient(0deg, rgba(242,242,245,0.12) 0 1px, transparent 1px 26px),
            repeating-linear-gradient(90deg, rgba(242,242,245,0.12) 0 1px, transparent 1px 26px);
          display: flex;
        }
        .ps-zone {
          flex: 1 1 0; position: relative;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 6px;
        }
        .ps-zone + .ps-zone { border-left: 2px dashed rgba(242,242,245,0.25); }
        .ps-zone.ps-zone-mine { background: rgba(171,221,100,0.14); }
        .ps-ball, .ps-glove {
          font-size: 44px; line-height: 1; visibility: hidden;
        }
        .ps-zone.ps-show-ball .ps-ball,
        .ps-zone.ps-show-glove .ps-glove {
          visibility: visible; animation: ps-drop 300ms ease-out;
        }
        @keyframes ps-drop {
          0% { transform: translateY(-40px) scale(0.5); opacity: 0; }
          100% { transform: translateY(0) scale(1); opacity: 1; }
        }
        .ps-status {
          flex: 0 0 auto; text-align: center; font-size: 14px;
          color: #9a9aa5; padding: 6px 8px;
        }
        .ps-buttons {
          flex: 0 0 auto; display: flex; gap: 10px; padding: 0 12px 14px;
        }
        .ps-btn {
          flex: 1 1 0; min-height: 76px; border: 2px solid #3a3a50;
          border-radius: 16px; background: #1a1a28; color: #f2f2f5;
          font-size: 18px; font-weight: 800;
          touch-action: manipulation; cursor: pointer;
        }
        .ps-btn:disabled { opacity: 0.45; cursor: default; }
        .ps-btn.ps-sel {
          border-color: #abdd64; background: #2a3a1c; color: #abdd64;
          animation: ps-picked 180ms ease-out;
        }
        @keyframes ps-picked {
          0% { transform: scale(1); }
          50% { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        /* Role theming — the two halves of a round must not look alike.
           Shooter = lime attack view (ball on the spot, SHOOT buttons);
           keeper = blue goalkeeper view (gloves on the line, DIVE buttons). */
        .ps.role-defend .ps-pitch {
          background: linear-gradient(to bottom, #10202e 0%, #16303e 100%);
        }
        .ps.role-defend .ps-zone.ps-zone-mine { background: rgba(100,181,221,0.18); }
        .ps.role-defend .ps-btn.ps-sel {
          border-color: #64b5dd; background: #16303e; color: #64b5dd;
        }
        .ps-spot {
          position: absolute; left: 50%; transform: translateX(-50%);
          bottom: 4px; font-size: 40px; line-height: 1; pointer-events: none;
        }
        .ps.role-defend .ps-goal { border-color: #64b5dd; }
        .ps-btn .ps-btn-icon { display: block; font-size: 22px; line-height: 1.2; }
      </style>
      <div class="ps-banner" id="ps-banner">connecting…</div>
      <div class="ps-sub" id="ps-sub"></div>
      <div class="ps-pitch">
        <div class="ps-goal" id="ps-goal">
          ${ZONES.map(
            (z) => `<div class="ps-zone" data-zone="${z}">
              <span class="ps-ball">⚽</span>
              <span class="ps-glove">🧤</span>
            </div>`,
          ).join("")}
        </div>
        <span class="ps-spot" id="ps-spot"></span>
      </div>
      <div class="ps-status" id="ps-status"></div>
      <div class="ps-buttons" id="ps-buttons">
        <button class="ps-btn" type="button" data-zone="left"><span class="ps-btn-icon"></span>⬅ LEFT</button>
        <button class="ps-btn" type="button" data-zone="center"><span class="ps-btn-icon"></span>CENTER</button>
        <button class="ps-btn" type="button" data-zone="right"><span class="ps-btn-icon"></span>RIGHT ➡</button>
      </div>
    </div>
  `;

  const rootEl = ctx.container.querySelector<HTMLElement>(".ps")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#ps-banner")!;
  const subEl = ctx.container.querySelector<HTMLElement>("#ps-sub")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#ps-status")!;
  const buttonsEl = ctx.container.querySelector<HTMLElement>("#ps-buttons")!;
  const zoneEls = new Map<Zone, HTMLElement>();
  ctx.container
    .querySelectorAll<HTMLElement>(".ps-zone")
    .forEach((el) => zoneEls.set(el.dataset.zone as Zone, el));
  const btnEls = new Map<Zone, HTMLButtonElement>();
  ctx.container
    .querySelectorAll<HTMLButtonElement>(".ps-btn")
    .forEach((el) => btnEls.set(el.dataset.zone as Zone, el));
  const flash = createMatchFlash(rootEl);

  let role: Role | null = null;
  let players: WelcomeMsg["players"] | null = null;

  // Own pick for the current round (client-side memory only, for the
  // button highlight). Reset when the round number changes.
  let pickedRound = 0;
  let pickedZone: Zone | null = null;
  let uiRound = 0;
  let revealedRound = 0; // last round we flashed GOAL!/SAVED! for
  let canPick = false;

  let lastTapAt = 0;
  function bindButton(zone: Zone, btn: HTMLButtonElement) {
    const tap = (e: Event) => {
      if (ctx.isSpectator || role === "spectator") return;
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastTapAt < 80) return;
      lastTapAt = now;
      if (!canPick) return;
      pickedZone = zone;
      pickedRound = uiRound;
      ctx.send({ type: "pick", zone });
      for (const [z, b] of btnEls) b.classList.toggle("ps-sel", z === zone);
    };
    btn.addEventListener("touchstart", tap, { passive: false });
    btn.addEventListener("mousedown", tap);
  }
  for (const [zone, btn] of btnEls) bindButton(zone, btn);

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    if (msg.players.p1.playerId === ctx.selfPlayerId) role = "p1";
    else if (msg.players.p2.playerId === ctx.selfPlayerId) role = "p2";
    else role = "spectator";
    if (role === "spectator") {
      // Spectators: nicknames + reveal outcomes only, no inputs.
      buttonsEl.hidden = true;
      // Nicknames only ever go through textContent — no innerHTML — so
      // user strings can't inject markup anywhere in this client.
      bannerEl.textContent = `${msg.players.p1.nickname} vs ${msg.players.p2.nickname}`;
    } else {
      bannerEl.textContent = "get ready…";
    }
  }

  function roundLabel(msg: StateMsg): string {
    return `round ${msg.round}/${msg.regRounds}`;
  }

  function applyState(msg: StateMsg) {
    if (role === null || players === null) return; // welcome not seen yet
    const p1Nick = () => players?.p1.nickname ?? "?";
    const p2Nick = () => players?.p2.nickname ?? "?";

    // New round → clear selection + reveal emojis.
    if (msg.round !== uiRound) {
      uiRound = msg.round;
      if (pickedRound !== uiRound) pickedZone = null;
      for (const b of btnEls.values()) b.classList.remove("ps-sel");
    }

    const iShoot = msg.shooterId === ctx.selfPlayerId;
    const iKeep = msg.keeperId === ctx.selfPlayerId;
    const shooterNick =
      msg.shooterId === players.p1.playerId
        ? players.p1.nickname
        : players.p2.nickname;
    const keeperNick =
      msg.keeperId === players.p1.playerId
        ? players.p1.nickname
        : players.p2.nickname;

    // Toolbar score, own perspective ("you 2 – 1 them · round 4/6").
    const myGoals = role === "p2" ? msg.goals.p2 : msg.goals.p1;
    const theirGoals = role === "p2" ? msg.goals.p1 : msg.goals.p2;
    ctx.setMatchScore(
      role === "spectator"
        ? `${msg.goals.p1} – ${msg.goals.p2} · ${roundLabel(msg)}`
        : `you ${myGoals} – ${theirGoals} them · ${roundLabel(msg)}`,
    );

    canPick = msg.phase === "choosing" && (iShoot || iKeep);
    for (const b of btnEls.values()) b.disabled = !canPick;

    // Role theming: the whole scene reads differently per role — lime
    // attack view with the ball on the spot vs blue keeper view with the
    // gloves, plus verb-labeled buttons (SHOOT vs DIVE).
    rootEl.classList.toggle("role-shoot", iShoot);
    rootEl.classList.toggle("role-defend", iKeep);
    const spotEl = rootEl.querySelector<HTMLElement>("#ps-spot")!;
    spotEl.textContent = iShoot ? "⚽" : iKeep ? "🧤" : "";
    const btnIcon = iShoot ? "⚽" : iKeep ? "🧤" : "";
    for (const b of btnEls.values()) {
      const icon = b.querySelector<HTMLElement>(".ps-btn-icon");
      if (icon && icon.textContent !== btnIcon) icon.textContent = btnIcon;
    }

    // Reveal emoji + zone highlight.
    for (const [zone, el] of zoneEls) {
      const r = msg.phase === "reveal" ? msg.reveal : null;
      el.classList.toggle("ps-show-ball", !!r && r.shooterZone === zone);
      el.classList.toggle("ps-show-glove", !!r && r.keeperZone === zone);
      el.classList.toggle(
        "ps-zone-mine",
        msg.phase === "choosing" && pickedZone === zone && canPick,
      );
    }

    if (msg.phase === "choosing") {
      const secs = Math.max(0, Math.ceil((msg.phaseEndsAt - Date.now()) / 1000));
      bannerEl.classList.toggle("ps-shoot", iShoot);
      bannerEl.classList.toggle("ps-defend", iKeep);
      if (iShoot) {
        bannerEl.textContent = "⚽ YOU SHOOT";
        subEl.textContent = pickedZone
          ? `shooting ${pickedZone} · ${secs}s`
          : `where do you SHOOT? ${secs}s`;
      } else if (iKeep) {
        bannerEl.textContent = "🧤 YOU'RE THE KEEPER";
        subEl.textContent = pickedZone
          ? `diving ${pickedZone} · ${secs}s`
          : `where do you DIVE? ${secs}s`;
      } else {
        bannerEl.textContent = `${shooterNick} shoots · ${keeperNick} defends`;
        subEl.textContent = `picking… ${secs}s`;
      }
    } else if (msg.phase === "reveal" && msg.reveal) {
      bannerEl.classList.remove("ps-shoot", "ps-defend");
      bannerEl.textContent = msg.reveal.scored ? "GOAL!" : "SAVED!";
      subEl.textContent = `${shooterNick} → ${msg.reveal.shooterZone} · ${keeperNick} ${
        msg.reveal.keeperPicked ? `dove ${msg.reveal.keeperZone}` : "stayed put (center)"
      }`;
      if (msg.reveal.round !== revealedRound) {
        revealedRound = msg.reveal.round;
        flash.flash(msg.reveal.scored ? "GOAL!" : "SAVED!");
      }
    } else if (msg.phase === "ended") {
      bannerEl.classList.remove("ps-shoot", "ps-defend");
      bannerEl.textContent = "shootout over";
      subEl.textContent = "";
    }

    // No total clock — rounds resolve as soon as both have picked; the
    // round label + pick countdown are the honest structure.
    statusEl.textContent = statusLine(
      msg.round <= msg.regRounds / 2
        ? `${p1Nick()} shoots first half`
        : `${p2Nick()} shoots second half`,
    );
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
    },
    unmount() {
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

const PenaltyShootoutClient: MiniGameClientDefinition = {
  id: "penalty-shootout",
  controlsHint: "3 shots each: pick left / center / right — goal if the keeper guesses wrong",
  createMatch: createPenaltyShootoutMatchClient,
};

registerMiniGameClient(PenaltyShootoutClient);

export default PenaltyShootoutClient;
