// Hot Bid client. Pure DOM sealed-bid auction. The prize card (crew sprite
// + big point value) sits front-and-center, your coin balance is prominent,
// and a big stepper (−5 / −1 / +1 / +5) + LOCK IN button sets your secret
// bid. The opponents row shows avatar + coins + a locked checkmark — never
// amounts. Reveal phase swaps the stepper for the sorted bid list with the
// winner pulsing; coin balances tick down visibly. Spectators watch
// everything but get no stepper.

import {
  cakeData,
  coinData,
  heartData,
  meatData,
  money_bagData,
  mushroomData,
  onionData,
  starData,
  type CrewAsset,
} from "@kaplayjs/crew";
import { avatarSrc } from "../../identity";
import { statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "bidding" | "reveal" | "ended";

type WelcomeMsg = {
  type: "welcome";
  startCoins: number;
  totalCards: number;
  bidMs: number;
  revealMs: number;
  startAt: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type Reveal = {
  cardIndex: number;
  value: number;
  sprite: string;
  bids: { playerId: string; amount: number }[];
  winnerId: string | null;
  tie: boolean;
  discarded: boolean;
  note: string;
};

type StateMsg = {
  type: "state";
  phase: Phase;
  cardIndex: number;
  totalCards: number;
  card: { value: number; sprite: string };
  phaseEndsAt: number;
  locked: Record<string, boolean>;
  coins: Record<string, number>;
  points: Record<string, number>;
  left: Record<string, boolean>;
  reveal: Reveal | null;
  deadlineAt: number;
};

type YourBidMsg = {
  type: "yourBid";
  cardIndex: number;
  amount: number;
  locked: boolean;
};

function crewSrc(data: CrewAsset): string {
  return data.kind === "Sprite" ? data.outlined : "";
}
const SPRITE_SRC: Record<string, string> = {
  money_bag: crewSrc(money_bagData),
  coin: crewSrc(coinData),
  star: crewSrc(starData),
  heart: crewSrc(heartData),
  cake: crewSrc(cakeData),
  meat: crewSrc(meatData),
  mushroom: crewSrc(mushroomData),
  onion: crewSrc(onionData),
};
function spriteSrc(key: string): string {
  return SPRITE_SRC[key] ?? SPRITE_SRC.coin;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function createHotBidMatchClient(ctx: MatchClientContext): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="hb">
      <style>
        .hb {
          position: relative; width: 100%; height: 100%;
          background: #0a0a14; color: #f2f2f5;
          display: flex; flex-direction: column;
          font-family: inherit; overflow: hidden;
        }
        .hb-status {
          padding: 6px 10px 0; text-align: center; font-size: 13px;
          color: #9a9aa5; min-height: 18px;
        }
        .hb-banner {
          padding: 2px 10px; text-align: center; font-size: 14px;
          color: #9a9aa5; min-height: 20px;
        }
        .hb-card {
          display: flex; flex-direction: column; align-items: center;
          gap: 4px; padding: 6px 10px 2px; flex: 0 0 auto;
        }
        .hb-card-img {
          width: 104px; height: 104px; image-rendering: pixelated;
        }
        .hb-card-value { font-size: 30px; font-weight: 800; color: #abdd64; }
        .hb-card-label { font-size: 13px; color: #9a9aa5; }
        .hb-wallet {
          text-align: center; font-size: 20px; font-weight: 800;
          padding: 4px 10px; min-height: 26px;
        }
        .hb-wallet span { color: #9a9aa5; font-weight: 600; font-size: 14px; }
        .hb-mid {
          flex: 1 1 auto; display: flex; flex-direction: column;
          align-items: center; justify-content: flex-start;
          min-height: 0; padding: 4px 10px; overflow-y: auto; width: 100%;
          box-sizing: border-box;
        }
        .hb-controls {
          display: flex; flex-direction: column; gap: 10px;
          width: 100%; max-width: 340px; align-items: stretch;
        }
        .hb-stepper {
          display: grid; grid-template-columns: 1fr 1fr 1.4fr 1fr 1fr;
          gap: 6px; align-items: stretch;
        }
        .hb-stepper button {
          min-height: 56px; font-size: 18px; font-weight: 800;
          background: #12121f; color: #f2f2f5; border: 1px solid #2c2c3d;
          border-radius: 12px; touch-action: manipulation; cursor: pointer;
          user-select: none; -webkit-user-select: none;
        }
        .hb-stepper button:active { background: #1d1d30; }
        .hb-stepper button:disabled { opacity: 0.35; }
        .hb-bid {
          display: flex; align-items: center; justify-content: center;
          font-size: 26px; font-weight: 800; background: #12121f;
          border: 1px solid #2c2c3d; border-radius: 12px; min-height: 56px;
        }
        .hb.locked .hb-bid { border-color: #abdd64; color: #abdd64; }
        .hb-lockbtn {
          min-height: 56px; font-size: 18px; font-weight: 800;
          border-radius: 12px; border: 1px solid #abdd64;
          background: #abdd64; color: #0a0a14; cursor: pointer;
          touch-action: manipulation; user-select: none; -webkit-user-select: none;
        }
        .hb-lockbtn:active { filter: brightness(1.1); }
        .hb-lockbtn:disabled { opacity: 0.5; }
        .hb.locked .hb-lockbtn {
          background: #12121f; color: #abdd64;
        }
        .hb-reveal { width: 100%; max-width: 340px; display: flex;
          flex-direction: column; gap: 5px; }
        .hb-reveal-note {
          text-align: center; font-size: 13px; color: #9a9aa5;
          min-height: 17px;
        }
        .hb-reveal-row {
          display: flex; align-items: center; gap: 8px;
          background: #12121f; border: 1px solid #22222f;
          border-radius: 10px; padding: 5px 10px;
        }
        .hb-reveal-row img { width: 26px; height: 26px; border-radius: 50%; }
        .hb-reveal-nick {
          flex: 1; font-size: 13px; color: #9a9aa5;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .hb-reveal-amt { font-size: 17px; font-weight: 800; }
        .hb-reveal-row.winner {
          border-color: #abdd64; background: #1c2413;
          animation: hb-pulse 0.8s ease-in-out infinite;
        }
        .hb-reveal-row.winner .hb-reveal-nick,
        .hb-reveal-row.winner .hb-reveal-amt { color: #abdd64; }
        @keyframes hb-pulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.045); }
          100% { transform: scale(1); }
        }
        .hb-row {
          display: flex; gap: 6px; padding: 6px 8px
            calc(8px + env(safe-area-inset-bottom, 0px));
          overflow-x: auto; flex: 0 0 auto;
        }
        .hb-cell {
          display: flex; flex-direction: column; align-items: center;
          gap: 2px; background: #12121f; border: 1px solid #22222f;
          border-radius: 10px; padding: 5px 6px; min-width: 56px;
          flex: 0 0 auto; position: relative;
        }
        .hb-cell img { width: 26px; height: 26px; border-radius: 50%; }
        .hb-cell.self { border-color: #abdd64; }
        .hb-cell.gone { opacity: 0.4; }
        .hb-cnick {
          font-size: 9px; color: #9a9aa5; max-width: 60px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .hb-cell.self .hb-cnick { color: #abdd64; font-weight: 700; }
        .hb-ccoins { font-size: 12px; font-weight: 700; }
        .hb-cpts { font-size: 10px; color: #9a9aa5; }
        .hb-ctick {
          position: absolute; top: -5px; right: -3px; font-size: 13px;
          background: #abdd64; color: #0a0a14; border-radius: 50%;
          width: 18px; height: 18px; line-height: 18px; text-align: center;
          font-weight: 800; display: none;
        }
        .hb-cell.locked .hb-ctick { display: block; }
        /* .hb is position:relative — anchors the global .match-flash overlay */
      </style>
      <div class="hb-status" id="hb-status"></div>
      <div class="hb-banner" id="hb-banner"></div>
      <div class="hb-card">
        <img class="hb-card-img" id="hb-card-img" alt="" />
        <div class="hb-card-value" id="hb-card-value"></div>
        <div class="hb-card-label" id="hb-card-label"></div>
      </div>
      <div class="hb-wallet" id="hb-wallet"></div>
      <div class="hb-mid">
        <div class="hb-controls" id="hb-controls" hidden>
          <div class="hb-stepper" id="hb-stepper">
            <button type="button" data-d="-5">−5</button>
            <button type="button" data-d="-1">−1</button>
            <div class="hb-bid" id="hb-bid">0</div>
            <button type="button" data-d="1">+1</button>
            <button type="button" data-d="5">+5</button>
          </div>
          <button type="button" class="hb-lockbtn" id="hb-lock">LOCK IN</button>
        </div>
        <div class="hb-reveal" id="hb-reveal" hidden>
          <div class="hb-reveal-note" id="hb-reveal-note"></div>
          <div id="hb-reveal-list"></div>
        </div>
      </div>
      <div class="hb-row" id="hb-row"></div>
    </div>
  `;

  const root = ctx.container.querySelector<HTMLElement>(".hb")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#hb-status")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#hb-banner")!;
  const cardImgEl = ctx.container.querySelector<HTMLImageElement>("#hb-card-img")!;
  const cardValueEl = ctx.container.querySelector<HTMLElement>("#hb-card-value")!;
  const cardLabelEl = ctx.container.querySelector<HTMLElement>("#hb-card-label")!;
  const walletEl = ctx.container.querySelector<HTMLElement>("#hb-wallet")!;
  const controlsEl = ctx.container.querySelector<HTMLElement>("#hb-controls")!;
  const bidEl = ctx.container.querySelector<HTMLElement>("#hb-bid")!;
  const lockBtn = ctx.container.querySelector<HTMLButtonElement>("#hb-lock")!;
  const revealEl = ctx.container.querySelector<HTMLElement>("#hb-reveal")!;
  const revealNoteEl = ctx.container.querySelector<HTMLElement>("#hb-reveal-note")!;
  const revealListEl = ctx.container.querySelector<HTMLElement>("#hb-reveal-list")!;
  const rowEl = ctx.container.querySelector<HTMLElement>("#hb-row")!;
  const stepBtns = [
    ...ctx.container.querySelectorAll<HTMLButtonElement>("#hb-stepper button"),
  ];

  const flash = createMatchFlash(root);

  let players: WelcomeMsg["players"] = [];
  let startAt = 0;
  let built = false;

  // Own secret bid (server truth arrives via yourBid; applied idempotently —
  // recent local edits win so the 500ms echo doesn't fight the stepper).
  let myBid = 0;
  let myLocked = false;
  let lastLocalEditAt = 0;
  let knownCardIndex = -1;
  let myCoins = 0;
  let lastState: StateMsg | null = null;

  // Displayed (ticking) coin values, lerped toward actual each state frame.
  const displayCoins = new Map<string, number>();

  // Reveal list is rebuilt once per card; winner flash fires once per card.
  let builtRevealFor = -1;
  let flashedFor = -1;

  const cellByPlayerId = new Map<string, HTMLElement>();

  function buildRoster() {
    rowEl.innerHTML = players
      .map(
        (p) => `<div class="hb-cell" data-pid="${escapeHtml(p.playerId)}">
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <div class="hb-cnick">${escapeHtml(p.nickname)}</div>
          <div class="hb-ccoins">0</div>
          <div class="hb-cpts"></div>
          <div class="hb-ctick">✓</div>
        </div>`,
      )
      .join("");
    cellByPlayerId.clear();
    rowEl.querySelectorAll<HTMLElement>(".hb-cell").forEach((el) => {
      cellByPlayerId.set(el.dataset.pid!, el);
      if (el.dataset.pid === ctx.selfPlayerId) el.classList.add("self");
    });
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    startAt = msg.startAt;
    for (const p of players) {
      if (!displayCoins.has(p.playerId)) displayCoins.set(p.playerId, msg.startCoins);
    }
    if (built) return; // welcome is replayed on reconnect — guard double-build
    built = true;
    buildRoster();
    bannerEl.textContent = "get ready…";
  }

  function nickOf(pid: string): string {
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }
  function avatarOf(pid: string): string {
    const p = players.find((pp) => pp.playerId === pid);
    return p ? avatarSrc(p.avatarId) : "";
  }

  function tickDisplayCoins(actual: Record<string, number>) {
    for (const p of players) {
      const target = actual[p.playerId] ?? 0;
      let cur = displayCoins.get(p.playerId) ?? target;
      if (cur > target) {
        cur = Math.max(target, cur - Math.max(1, Math.ceil((cur - target) / 8)));
      } else if (cur < target) {
        cur = target;
      }
      displayCoins.set(p.playerId, cur);
    }
  }

  function renderBid() {
    bidEl.textContent = String(myBid);
    root.classList.toggle("locked", myLocked);
    lockBtn.textContent = myLocked ? "LOCKED ✓" : "LOCK IN";
    lockBtn.disabled = myLocked;
    for (const b of stepBtns) b.disabled = myLocked;
  }

  function renderReveal(reveal: Reveal) {
    if (builtRevealFor !== reveal.cardIndex) {
      builtRevealFor = reveal.cardIndex;
      revealNoteEl.textContent = reveal.note;
      revealListEl.innerHTML = reveal.bids
        .map((b) => {
          const winner = reveal.winnerId === b.playerId;
          return `<div class="hb-reveal-row${winner ? " winner" : ""}">
            <img src="${avatarOf(b.playerId)}" alt="" />
            <div class="hb-reveal-nick">${escapeHtml(nickOf(b.playerId))}${
              b.playerId === ctx.selfPlayerId ? " (you)" : ""
            }</div>
            <div class="hb-reveal-amt">${b.amount}</div>
          </div>`;
        })
        .join("");
    }
    if (
      reveal.winnerId === ctx.selfPlayerId &&
      !ctx.isSpectator &&
      flashedFor !== reveal.cardIndex
    ) {
      flashedFor = reveal.cardIndex;
      flash.flash("CARD WON!");
    }
  }

  function applyState(msg: StateMsg) {
    lastState = msg;

    // New card → reset the local secret bid.
    if (msg.cardIndex !== knownCardIndex) {
      knownCardIndex = msg.cardIndex;
      myBid = 0;
      myLocked = false;
      lastLocalEditAt = 0;
    }
    // Server lock state is authoritative within a card (OR with optimistic).
    myLocked = myLocked || !!msg.locked[ctx.selfPlayerId];
    myCoins = msg.coins[ctx.selfPlayerId] ?? 0;

    tickDisplayCoins(msg.coins);

    // Card front-and-center — sprite + value always visible to everyone.
    const src = spriteSrc(msg.card.sprite);
    if (cardImgEl.getAttribute("src") !== src) cardImgEl.setAttribute("src", src);
    cardValueEl.textContent = `+${msg.card.value} PTS`;
    cardLabelEl.textContent = `card ${Math.min(msg.cardIndex + 1, msg.totalCards)}/${msg.totalCards}`;

    // Status line: round indicator + phase countdown + match clock.
    const phaseSecs = Math.max(0, Math.ceil((msg.phaseEndsAt - Date.now()) / 1000));
    statusEl.textContent = statusLine(
      msg.phase === "bidding"
        ? `bidding · ${phaseSecs}s`
        : msg.phase === "reveal"
          ? `reveal · ${phaseSecs}s`
          : "final results",
      // No total clock — bidding rounds end early once everyone locks in.
    );

    // Wallet (own balance prominent; spectators have none).
    if (ctx.isSpectator) {
      walletEl.innerHTML = `<span>spectating</span>`;
    } else {
      const shownCoins = displayCoins.get(ctx.selfPlayerId) ?? myCoins;
      const pts = msg.points[ctx.selfPlayerId] ?? 0;
      walletEl.innerHTML = `🪙 ${shownCoins} <span>coins · ${pts} pts</span>`;
      ctx.setMatchScore(`${pts} pts · ${myCoins} coins`);
    }

    // Banner.
    if (msg.phase === "bidding") {
      bannerEl.textContent = ctx.isSpectator
        ? "secret bids incoming…"
        : myLocked
          ? "locked in"
          : "";
    } else if (msg.phase === "reveal") {
      bannerEl.textContent = msg.reveal?.discarded
        ? "nobody wanted it!"
        : msg.reveal?.tie
          ? "tie · coin flip!"
          : "the bids are in!";
    } else {
      bannerEl.textContent = "auction over";
    }

    // Stepper vs reveal panel.
    const bidding = msg.phase === "bidding";
    controlsEl.hidden = !bidding || ctx.isSpectator;
    revealEl.hidden = bidding || !msg.reveal;
    if (!bidding && msg.reveal) renderReveal(msg.reveal);
    if (bidding) renderBid();

    // Opponents row: avatar + ticking coins + points + locked checkmark
    // (never amounts during bidding).
    for (const p of players) {
      const cell = cellByPlayerId.get(p.playerId);
      if (!cell) continue;
      cell.classList.toggle("locked", bidding && !!msg.locked[p.playerId]);
      cell.classList.toggle("gone", !!msg.left[p.playerId]);
      const coinsEl = cell.querySelector<HTMLElement>(".hb-ccoins");
      if (coinsEl)
        coinsEl.textContent = `🪙${displayCoins.get(p.playerId) ?? 0}`;
      const ptsEl = cell.querySelector<HTMLElement>(".hb-cpts");
      if (ptsEl) ptsEl.textContent = `${msg.points[p.playerId] ?? 0} pts`;
    }
  }

  function applyYourBid(msg: YourBidMsg) {
    if (ctx.isSpectator) return;
    if (knownCardIndex >= 0 && msg.cardIndex !== knownCardIndex) return;
    // Idempotent resync: server truth wins unless the player edited within
    // the last ~1.2s (their newer bid message is still in flight).
    if (msg.locked || Date.now() - lastLocalEditAt > 1200) {
      myBid = msg.amount;
      myLocked = myLocked || msg.locked;
      if (lastState?.phase === "bidding") renderBid();
    }
  }

  // --- input -------------------------------------------------------------
  let lastTapAt = 0;
  function tapGate(e: Event): boolean {
    if (ctx.isSpectator) return false;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapAt < 80) return false;
    lastTapAt = now;
    if (startAt && now < startAt) return false; // warm-up: server ignores anyway
    if (!lastState || lastState.phase !== "bidding") return false;
    return true;
  }

  for (const btn of stepBtns) {
    const delta = Number(btn.dataset.d);
    const onTap = (e: Event) => {
      if (!tapGate(e)) return;
      if (myLocked) return;
      myBid = Math.max(0, Math.min(myCoins, myBid + delta));
      lastLocalEditAt = Date.now();
      ctx.send({ type: "bid", amount: myBid });
      renderBid();
    };
    btn.addEventListener("touchstart", onTap, { passive: false });
    btn.addEventListener("mousedown", onTap);
  }

  const onLock = (e: Event) => {
    if (!tapGate(e)) return;
    if (myLocked) return;
    myLocked = true;
    // Make sure the server has the final amount, then freeze it.
    ctx.send({ type: "bid", amount: myBid });
    ctx.send({ type: "lock" });
    renderBid();
  };
  lockBtn.addEventListener("touchstart", onLock, { passive: false });
  lockBtn.addEventListener("mousedown", onLock);

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
      else if (msg.type === "yourBid") applyYourBid(msg as unknown as YourBidMsg);
    },
    unmount() {
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

const HotBidClient: MiniGameClientDefinition = {
  id: "hot-bid",
  controlsHint: "secretly bid coins on each card — highest bid pays & wins it",
  createMatch: createHotBidMatchClient,
};

registerMiniGameClient(HotBidClient);

export default HotBidClient;
