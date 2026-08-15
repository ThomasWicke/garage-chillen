// Marble Race match client (id "marble-derby"). Kaplay scene renders the
// plinko board (pegs, walls, finish line) and the six racer marbles as
// @kaplayjs/crew character sprites. Nobody steers anything — the DOM overlay
// carries the whole betting spectacle: racer cards to tap a bet on, phase
// banner + countdown, results panel, and avatar chips showing who backed
// which racer once bets are revealed at race start.

import kaplay from "kaplay";
import type {
  AnchorComp,
  ColorComp,
  GameObj,
  PosComp,
  SpriteComp,
} from "kaplay";
import {
  bagData,
  beanData,
  boboData,
  ghostyData,
  katData,
  markData,
} from "@kaplayjs/crew";
import { avatarSrc } from "../../identity";
import { formatRemaining, statusLine } from "../clock";
import { createMatchFlash } from "../flash";
import { registerMiniGameClient } from "../registry";
import type {
  MatchClientContext,
  MatchClientSession,
  MiniGameClientDefinition,
} from "../types";

type Phase = "betting" | "race" | "results";

type WelcomeMsg = {
  type: "welcome";
  field: { w: number; h: number };
  pegs: { x: number; y: number }[];
  pegRadius: number;
  marbleRadius: number;
  finishY: number;
  racers: string[];
  races: number;
  bettingMs: number;
  resultsMs: number;
  winPoints: number;
  secondPoints: number;
  deadlineAt: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type StateMsg = {
  type: "state";
  phase: Phase;
  raceIndex: number;
  phaseEndsAt: number;
  marbles: { x: number; y: number }[];
  points: Record<string, number>;
  lastResult: {
    raceIndex: number;
    winner: number;
    second: number;
    /** Full finish order (racer indices, best→worst). */
    order: number[];
  } | null;
  deadlineAt: number;
  hasBet?: string[];
  bets?: Record<string, number>;
};

type YourBetMsg = { type: "your-bet"; raceIndex: number; racer: number };

type MarbleSprite = GameObj<PosComp | SpriteComp | AnchorComp | ColorComp>;

const CREW_BY_KEY: Record<string, { kind: string; outlined?: string }> = {
  bean: beanData,
  ghosty: ghostyData,
  mark: markData,
  kat: katData,
  bag: bagData,
  bobo: boboData,
};

function crewSrc(key: string): string {
  const data = CREW_BY_KEY[key];
  if (!data) return "";
  return data.kind === "Sprite" ? (data.outlined ?? "") : "";
}

function racerLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
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

function createMarbleDerbyMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <style>
      .mdby {
        flex: 1; display: flex; flex-direction: column;
        min-height: 0; background: #0a0a14; color: #f2f2f5;
        position: relative; /* anchors the .match-flash overlay */
      }
      .mdby-stage { flex: 1; position: relative; overflow: hidden; min-height: 0; }
      .mdby-stage canvas { display: block; }
      .mdby-banner {
        position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
        background: rgba(10, 10, 20, 0.85); border: 1px solid #2a2a3a;
        border-radius: 10px; padding: 6px 14px; font-size: 14px;
        font-weight: 700; white-space: nowrap; z-index: 3;
        color: #f2f2f5; user-select: none; pointer-events: none;
      }
      .mdby-banner .mdby-count { color: #abdd64; }
      .mdby-panel {
        flex: none; display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 6px; padding: 8px; background: #101020;
      }
      .mdby-card {
        display: flex; flex-direction: column; align-items: center;
        gap: 2px; min-height: 64px; padding: 6px 2px 4px;
        background: #1a1a2c; border: 2px solid #2a2a3a; border-radius: 10px;
        font: inherit; color: #f2f2f5; user-select: none;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      }
      .mdby-card img { width: 36px; height: 36px; object-fit: contain; pointer-events: none; }
      .mdby-card .mdby-card-name { font-size: 11px; color: #9a9aa5; pointer-events: none; }
      .mdby-card.mdby-picked {
        border-color: #abdd64; background: #223018;
        box-shadow: 0 0 10px rgba(171, 221, 100, 0.35);
      }
      .mdby-card.mdby-picked .mdby-card-name { color: #abdd64; }
      .mdby-card.mdby-disabled { opacity: 0.88; }
      .mdby-results .mdby-results-mine {
        font-size: 17px; font-weight: 800; padding: 6px 14px;
        border-radius: 10px; background: #1a1a2c; border: 1px solid #2a2a3a;
      }
      .mdby-results .mdby-results-mine.mdby-mine-win { color: #abdd64; border-color: #abdd64; }
      .mdby-results .mdby-results-mine.mdby-mine-second { color: #ffd75e; border-color: #ffd75e; }
      .mdby-results .mdby-results-order { font-size: 13px; color: #9a9aa5; }
      .mdby-results .mdby-results-order strong { color: #f2f2f5; font-weight: 700; }
      .mdby-card.mdby-race-winner { border-color: #ffd75e; }
      .mdby-chips {
        display: flex; flex-wrap: wrap; justify-content: center; gap: 2px;
        min-height: 14px; pointer-events: none;
      }
      .mdby-chips img {
        width: 14px; height: 14px; border-radius: 50%;
        border: 1px solid #2a2a3a; background: #0a0a14;
      }
      .mdby-results {
        position: absolute; inset: 0; z-index: 4;
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 8px; text-align: center;
        background: rgba(10, 10, 20, 0.88); padding: 20px;
        animation: mdby-pop 0.25s ease;
      }
      @keyframes mdby-pop {
        0% { opacity: 0; transform: scale(0.94); }
        100% { opacity: 1; transform: scale(1); }
      }
      .mdby-results img.mdby-results-winner {
        width: 110px; height: 110px; object-fit: contain;
        animation: mdby-bounce 0.9s ease infinite alternate;
      }
      @keyframes mdby-bounce {
        0% { transform: translateY(0); }
        100% { transform: translateY(-10px); }
      }
      .mdby-results .mdby-results-title { font-size: 22px; font-weight: 800; color: #abdd64; }
      .mdby-results .mdby-results-second { font-size: 14px; color: #9a9aa5; }
      .mdby-results .mdby-results-scorers { font-size: 13px; color: #f2f2f5; max-width: 90%; }
      .mdby-results .mdby-results-scorers .mdby-none { color: #9a9aa5; }
      .mdby-status {
        padding: 6px 0 8px; text-align: center; color: #9a9aa5;
        font-size: 12px; flex: none; user-select: none;
      }
    </style>
    <div class="mdby">
      <div class="mdby-stage" id="mdby-stage">
        <div class="mdby-banner" id="mdby-banner">connecting…</div>
        <div class="mdby-results" id="mdby-results" hidden></div>
      </div>
      <div class="mdby-panel" id="mdby-panel" hidden></div>
      <div class="mdby-status" id="mdby-status">connecting…</div>
    </div>
  `;
  const stageEl = ctx.container.querySelector<HTMLElement>("#mdby-stage")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#mdby-banner")!;
  const resultsEl = ctx.container.querySelector<HTMLElement>("#mdby-results")!;
  const panelEl = ctx.container.querySelector<HTMLElement>("#mdby-panel")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#mdby-status")!;
  const flash = createMatchFlash(
    ctx.container.querySelector<HTMLElement>(".mdby")!,
  );

  type KaplayCtx = ReturnType<typeof kaplay>;
  let k: KaplayCtx | null = null;
  let spritesReady = false;
  let marbleSprites: MarbleSprite[] = [];

  let racers: string[] = [];
  let totalRaces = 2;
  let marbleRadius = 13;
  let players: WelcomeMsg["players"] = [];
  const playerById = new Map<string, WelcomeMsg["players"][number]>();

  /** My pick per raceIndex (local echo + server your-bet resync). */
  const myPick = new Map<number, number>();
  let lastTapAt = 0;
  let prevPhase: Phase | null = null;
  let renderedResultKey = "";
  let renderedChipsKey = "";

  const cardEls: HTMLElement[] = [];
  const chipEls: HTMLElement[] = [];

  function buildPanel() {
    panelEl.innerHTML = racers
      .map(
        (key, i) => `<button class="mdby-card" type="button" data-racer="${i}">
          <img src="${crewSrc(key)}" alt="" draggable="false" />
          <div class="mdby-card-name">${escapeHtml(racerLabel(key))}</div>
          <div class="mdby-chips"></div>
        </button>`,
      )
      .join("");
    cardEls.length = 0;
    chipEls.length = 0;
    panelEl.querySelectorAll<HTMLElement>(".mdby-card").forEach((el) => {
      cardEls.push(el);
      chipEls.push(el.querySelector<HTMLElement>(".mdby-chips")!);
    });
    panelEl.hidden = false;

    if (!ctx.isSpectator) {
      const tap = (e: Event) => {
        e.preventDefault();
        const now = Date.now();
        if (now - lastTapAt < 80) return;
        lastTapAt = now;
        const target = (e.currentTarget as HTMLElement) ?? null;
        if (!target || target.classList.contains("mdby-disabled")) return;
        const racer = Number(target.dataset.racer);
        if (!Number.isFinite(racer)) return;
        ctx.send({ type: "bet", racer });
        // Local echo; the server's your-bet resend confirms/corrects it.
        myPick.set(currentRaceIndex, racer);
        updateCardHighlights();
      };
      for (const el of cardEls) {
        el.addEventListener("touchstart", tap, { passive: false });
        el.addEventListener("mousedown", tap);
      }
    }
  }

  let currentRaceIndex = 0;
  let bettingOpen = false;

  function updateCardHighlights() {
    const pick = myPick.get(currentRaceIndex);
    for (let i = 0; i < cardEls.length; i++) {
      cardEls[i].classList.toggle("mdby-picked", pick === i);
      cardEls[i].classList.toggle(
        "mdby-disabled",
        !bettingOpen || ctx.isSpectator,
      );
    }
  }

  function updateChips(bets: Record<string, number> | undefined, winner: number | null) {
    const key = `${currentRaceIndex}:${winner}:${JSON.stringify(bets ?? {})}`;
    if (key === renderedChipsKey) return;
    renderedChipsKey = key;
    const byRacer: string[][] = racers.map(() => []);
    if (bets) {
      for (const [pid, racer] of Object.entries(bets)) {
        if (racer >= 0 && racer < byRacer.length) byRacer[racer].push(pid);
      }
    }
    for (let i = 0; i < chipEls.length; i++) {
      chipEls[i].innerHTML = byRacer[i]
        .map((pid) => {
          const p = playerById.get(pid);
          if (!p) return "";
          return `<img src="${avatarSrc(p.avatarId)}" alt="" title="${escapeHtml(p.nickname)}" />`;
        })
        .join("");
      cardEls[i].classList.toggle("mdby-race-winner", winner === i);
    }
  }

  function buildScene(welcome: WelcomeMsg) {
    if (k) return;
    racers = welcome.racers;
    totalRaces = welcome.races;
    marbleRadius = welcome.marbleRadius;
    players = welcome.players;
    playerById.clear();
    for (const p of players) playerById.set(p.playerId, p);

    k = kaplay({
      width: welcome.field.w,
      height: welcome.field.h,
      // Lifted from near-black — the board looked "darkened" next to the
      // bright betting cards, as if it were disabled.
      background: [30, 30, 50],
      letterbox: true,
      global: false,
      root: stageEl,
      touchToMouse: false,
    });
    const kk = k;

    // Side walls.
    kk.add([
      kk.rect(6, welcome.field.h),
      kk.pos(0, 0),
      kk.anchor("topleft"),
      kk.color(80, 80, 110),
    ]);
    kk.add([
      kk.rect(6, welcome.field.h),
      kk.pos(welcome.field.w - 6, 0),
      kk.anchor("topleft"),
      kk.color(80, 80, 110),
    ]);

    // Finish line — bright strip at finishY.
    kk.add([
      kk.rect(welcome.field.w, 6),
      kk.pos(0, welcome.finishY),
      kk.anchor("topleft"),
      kk.color(171, 221, 100),
    ]);

    // Pegs (geometry — shapes are fine per contract).
    for (const peg of welcome.pegs) {
      kk.add([
        kk.circle(welcome.pegRadius),
        kk.pos(peg.x, peg.y),
        kk.anchor("center"),
        kk.color(205, 205, 220),
      ]);
    }

    // Racer marbles — crew character sprites, created after load.
    for (let i = 0; i < racers.length; i++) {
      kk.loadSprite(`mdby-racer-${i}`, crewSrc(racers[i]));
    }
    kk.onLoad(() => {
      spritesReady = true;
    });

    buildPanel();
  }

  function ensureMarbleSprites(): boolean {
    if (!k || !spritesReady) return false;
    if (marbleSprites.length > 0) return true;
    const kk = k;
    for (let i = 0; i < racers.length; i++) {
      const s = kk.add([
        kk.sprite(`mdby-racer-${i}`, {
          width: marbleRadius * 2.4,
          height: marbleRadius * 2.4,
        }),
        kk.pos(-99, -99),
        kk.anchor("center"),
        kk.color(255, 255, 255),
      ]);
      marbleSprites.push(s as unknown as MarbleSprite);
    }
    return true;
  }

  function renderResults(msg: StateMsg) {
    const res = msg.lastResult;
    if (!res) return;
    const key = `${res.raceIndex}:${res.winner}:${res.second}`;
    if (renderedResultKey === key && !resultsEl.hidden) return;
    renderedResultKey = key;
    const bets = msg.bets ?? {};
    const winners: string[] = [];
    const seconds: string[] = [];
    for (const [pid, racer] of Object.entries(bets)) {
      const p = playerById.get(pid);
      if (!p) continue;
      if (racer === res.winner) winners.push(p.nickname);
      else if (racer === res.second) seconds.push(p.nickname);
    }
    const winnerKey = racers[res.winner] ?? "";
    const scorerLines: string[] = [];
    if (winners.length > 0) {
      scorerLines.push(`+3 · ${winners.map(escapeHtml).join(", ")}`);
    }
    if (seconds.length > 0) {
      scorerLines.push(`+1 · ${seconds.map(escapeHtml).join(", ")}`);
    }

    // Full finish order — "1st Bean · 2nd Kat · 3rd Bobo · …".
    const order = res.order ?? [res.winner, res.second];
    const ordinal = (n: number) =>
      n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
    const orderLine = order
      .map(
        (racer, i) =>
          `${ordinal(i + 1)} <strong>${escapeHtml(racerLabel(racers[racer] ?? "?"))}</strong>`,
      )
      .join(" · ");

    // Personal outcome — the playtest complaint was "did my pick get 2nd or
    // 3rd?"; answer it in one big line.
    const mine = ctx.isSpectator ? undefined : myPick.get(res.raceIndex);
    let mineLine = "";
    if (mine !== undefined) {
      const place = order.indexOf(mine) + 1;
      const cls =
        place === 1
          ? "mdby-mine-win"
          : place === 2
            ? "mdby-mine-second"
            : "";
      const pts = place === 1 ? " (+3)" : place === 2 ? " (+1)" : " (+0)";
      mineLine = `<div class="mdby-results-mine ${cls}">your pick: ${escapeHtml(
        racerLabel(racers[mine] ?? "?"),
      )} → ${place > 0 ? ordinal(place) : "?"}${pts}</div>`;
    } else if (!ctx.isSpectator) {
      mineLine = `<div class="mdby-results-mine">you didn't bet this race</div>`;
    }

    resultsEl.innerHTML = `
      <img class="mdby-results-winner" src="${crewSrc(winnerKey)}" alt="" />
      <div class="mdby-results-title">${escapeHtml(racerLabel(winnerKey))} wins race ${res.raceIndex + 1}!</div>
      ${mineLine}
      <div class="mdby-results-order">${orderLine}</div>
      <div class="mdby-results-scorers">${
        scorerLines.length > 0
          ? scorerLines.join("<br/>")
          : `<span class="mdby-none">nobody backed the winner…</span>`
      }</div>
    `;
    resultsEl.hidden = false;
  }

  function applyWelcome(msg: WelcomeMsg) {
    statusEl.textContent = "pick your racer!";
    buildScene(msg);
  }

  function applyState(msg: StateMsg) {
    if (!k) return;
    currentRaceIndex = msg.raceIndex;
    bettingOpen = msg.phase === "betting";

    // Marbles — crew sprites, positions straight from the server.
    if (msg.marbles.length > 0) {
      if (ensureMarbleSprites()) {
        for (let i = 0; i < marbleSprites.length; i++) {
          const m = msg.marbles[i];
          if (!m) continue;
          marbleSprites[i].hidden = false;
          marbleSprites[i].pos.x = m.x;
          marbleSprites[i].pos.y = m.y;
        }
      }
    } else {
      for (const s of marbleSprites) s.hidden = true;
    }

    // Phase banner + countdown (updated here — 30Hz state is plenty).
    const secsLeft = Math.max(
      0,
      Math.ceil((msg.phaseEndsAt - Date.now()) / 1000),
    );
    if (msg.phase === "betting") {
      const betCount = msg.hasBet?.length ?? 0;
      const mine = myPick.get(msg.raceIndex);
      const pickTxt =
        ctx.isSpectator
          ? "betting open"
          : mine !== undefined
            ? `your pick: ${racerLabel(racers[mine] ?? "?")}`
            : "tap a racer to bet";
      bannerEl.innerHTML = `race ${msg.raceIndex + 1}/${totalRaces} · ${escapeHtml(pickTxt)} · <span class="mdby-count">${secsLeft}s</span> · ${betCount}/${players.length} bets in`;
    } else if (msg.phase === "race") {
      bannerEl.innerHTML = `race ${msg.raceIndex + 1}/${totalRaces} · they're off!`;
    } else {
      bannerEl.innerHTML = `race ${msg.raceIndex + 1}/${totalRaces} · results · <span class="mdby-count">${secsLeft}s</span>`;
    }

    // Betting panel state + revealed-bet chips.
    updateCardHighlights();
    if (msg.phase === "betting") {
      updateChips(undefined, null);
      resultsEl.hidden = true;
      renderedResultKey = "";
    } else {
      updateChips(msg.bets, msg.phase === "results" ? (msg.lastResult?.winner ?? null) : null);
    }

    // Results overlay + flash on entering results.
    if (msg.phase === "results") {
      renderResults(msg);
      if (prevPhase !== "results" && msg.lastResult) {
        if (
          !ctx.isSpectator &&
          myPick.get(msg.lastResult.raceIndex) === msg.lastResult.winner
        ) {
          flash.flash("WINNER!");
        }
      }
    }
    prevPhase = msg.phase;

    // Toolbar score + status line.
    const myPts = msg.points[ctx.selfPlayerId];
    if (!ctx.isSpectator && myPts !== undefined) {
      ctx.setMatchScore(`${myPts} pts`);
    } else {
      ctx.setMatchScore(null);
    }
    const clock = formatRemaining(msg.deadlineAt);
    statusEl.textContent = statusLine(
      ctx.isSpectator ? "spectating" : null,
      msg.phase === "betting"
        ? "place your bet"
        : msg.phase === "race"
          ? "no touching — watch the marbles"
          : "payouts",
      clock,
    );
  }

  function applyYourBet(msg: YourBetMsg) {
    if (
      typeof msg.raceIndex !== "number" ||
      typeof msg.racer !== "number" ||
      !Number.isFinite(msg.racer)
    ) {
      return;
    }
    // Idempotent resync (covers reconnect mid-betting).
    myPick.set(msg.raceIndex, Math.floor(msg.racer));
    updateCardHighlights();
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
      else if (msg.type === "your-bet")
        applyYourBet(msg as unknown as YourBetMsg);
    },
    unmount() {
      flash.destroy();
      try {
        k?.quit();
      } catch {
        /* ignore */
      }
      k = null;
      marbleSprites = [];
      ctx.container.innerHTML = "";
    },
  };
}

const MarbleDerbyClient: MiniGameClientDefinition = {
  id: "marble-derby",
  controlsHint: "bet on a marble — winner +3, second +1, best of 2 races",
  createMatch: createMarbleDerbyMatchClient,
};

registerMiniGameClient(MarbleDerbyClient);

export default MarbleDerbyClient;
