// Spy Signal client. Pure DOM. The game happens IN THE ROOM — the phone
// only shows your secret symbol during "peek", deliberately shows nothing
// revealing during "discuss" (the accusations are verbal), collects your
// vote during "vote", and shows the big reveal at the end of each round.
//
// Secrets arrive via per-player `secret` messages (re-sent ~500ms during
// peek; applied idempotently, keyed by round). A player who reconnects
// after peek never gets one and sees "you missed the peek".

import {
  appleData,
  coinData,
  eggData,
  fireData,
  ghostyData,
  heartData,
  moonData,
  mushroomData,
  starData,
  swordData,
  type CrewAsset,
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

type Phase = "peek" | "discuss" | "vote" | "reveal" | "ended";

type WelcomeMsg = {
  type: "welcome";
  deadlineAt: number;
  startAt: number;
  totalRounds: number;
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type Reveal = {
  spyId: string;
  spyNickname: string;
  targetSymbol: string;
  spySymbol: string;
  accusedId: string | null;
  caught: boolean;
  fled: boolean;
  tie: boolean;
  votes: Record<string, string>;
  awarded: Record<string, number>;
};

type StateMsg = {
  type: "state";
  phase: Phase;
  round: number;
  totalRounds: number;
  candidates: string[];
  phaseEndsAt: number;
  deadlineAt: number;
  points: Record<string, number>;
  votedIds: string[];
  connected: string[];
  reveal: Reveal | null;
};

type SecretMsg = { type: "secret"; round: number; symbol: string };

function crewSrc(data: CrewAsset): string {
  return data.kind === "Sprite" ? data.outlined : "";
}
const SPRITE_SRC: Record<string, string> = {
  apple: crewSrc(appleData),
  ghosty: crewSrc(ghostyData),
  heart: crewSrc(heartData),
  moon: crewSrc(moonData),
  star: crewSrc(starData),
  fire: crewSrc(fireData),
  coin: crewSrc(coinData),
  mushroom: crewSrc(mushroomData),
  sword: crewSrc(swordData),
  egg: crewSrc(eggData),
};
function spriteSrc(key: string): string {
  return SPRITE_SRC[key] ?? SPRITE_SRC.ghosty;
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

function createSpySignalMatchClient(
  ctx: MatchClientContext,
): MatchClientSession {
  ctx.container.innerHTML = `
    <div class="spy-root" id="spy-root">
      <style>
        .spy-root {
          position: relative;
          box-sizing: border-box;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 14px 14px 20px;
          background: #0a0a14;
          color: #f2f2f5;
          text-align: center;
          overflow-y: auto;
        }
        .spy-status { font-size: 13px; color: #9a9aa5; }
        .spy-banner {
          font-size: clamp(20px, 6.5vw, 30px);
          font-weight: 800;
          color: #abdd64;
          min-height: 1.3em;
          line-height: 1.2;
        }
        .spy-sub {
          font-size: 15px;
          color: #f2f2f5;
          min-height: 1.3em;
        }
        .spy-count {
          font-size: clamp(30px, 11vw, 52px);
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          color: #f2f2f5;
        }
        .spy-symbols {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          width: min(320px, 90%);
        }
        .spy-sym {
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 14px;
          padding: 14px 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
        }
        .spy-sym img {
          width: 72px;
          height: 72px;
          image-rendering: pixelated;
          pointer-events: none;
        }
        .spy-sym.spy-mine {
          border-color: #abdd64;
          box-shadow: 0 0 18px rgba(171, 221, 100, 0.55);
          transform: scale(1.06);
        }
        .spy-vote-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
          gap: 10px;
          width: 100%;
          max-width: 420px;
        }
        .spy-vote-cell {
          position: relative;
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 12px;
          padding: 8px 4px;
          min-height: 84px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .spy-vote-cell img {
          width: 48px;
          height: 48px;
          border-radius: 8px;
          pointer-events: none;
        }
        .spy-vote-cell .spy-nick {
          font-size: 12px;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          pointer-events: none;
        }
        .spy-vote-cell.spy-picked {
          border-color: #abdd64;
          box-shadow: 0 0 14px rgba(171, 221, 100, 0.5);
        }
        .spy-vote-cell.spy-gone { opacity: 0.35; cursor: default; }
        .spy-voted-badge {
          position: absolute;
          top: 4px;
          right: 6px;
          font-size: 13px;
          font-weight: 800;
          color: #abdd64;
          pointer-events: none;
        }
        .spy-reveal {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          width: min(340px, 92%);
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 16px;
          padding: 14px;
          animation: spy-pop 0.35s ease-out;
        }
        @keyframes spy-pop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .spy-reveal-spy img {
          width: 64px;
          height: 64px;
          border-radius: 10px;
        }
        .spy-reveal-spy .spy-nick { font-size: 15px; font-weight: 700; }
        .spy-reveal-syms {
          display: flex;
          gap: 18px;
          justify-content: center;
        }
        .spy-reveal-syms .spy-rs {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: #9a9aa5;
        }
        .spy-reveal-syms img {
          width: 64px;
          height: 64px;
          image-rendering: pixelated;
        }
        .spy-reveal-verdict {
          font-size: 17px;
          font-weight: 800;
          color: #abdd64;
        }
        .spy-reveal-verdict.spy-bad { color: #e0596a; }
        .spy-reveal-scored { font-size: 13px; color: #9a9aa5; }
        .spy-muted { color: #9a9aa5; }
      </style>
      <div class="spy-status" id="spy-status"></div>
      <div class="spy-banner" id="spy-banner"></div>
      <div class="spy-sub" id="spy-sub"></div>
      <div class="spy-count" id="spy-count" hidden></div>
      <div class="spy-symbols" id="spy-symbols" hidden></div>
      <div class="spy-vote-grid" id="spy-vote" hidden></div>
      <div class="spy-reveal" id="spy-reveal" hidden></div>
    </div>
  `;
  const rootEl = ctx.container.querySelector<HTMLElement>("#spy-root")!;
  const statusEl = ctx.container.querySelector<HTMLElement>("#spy-status")!;
  const bannerEl = ctx.container.querySelector<HTMLElement>("#spy-banner")!;
  const subEl = ctx.container.querySelector<HTMLElement>("#spy-sub")!;
  const countEl = ctx.container.querySelector<HTMLElement>("#spy-count")!;
  const symbolsEl = ctx.container.querySelector<HTMLElement>("#spy-symbols")!;
  const voteEl = ctx.container.querySelector<HTMLElement>("#spy-vote")!;
  const revealEl = ctx.container.querySelector<HTMLElement>("#spy-reveal")!;
  const flash = createMatchFlash(rootEl);

  let players: WelcomeMsg["players"] = [];
  let built = false;
  let amParticipant = false;

  /** round → secret symbol key. Idempotent apply; re-sent by the server. */
  const secretByRound = new Map<number, string>();
  /** Local record of own vote per round (broadcasts never say who-for-whom). */
  let myVoteRound = 0;
  let myVoteTarget: string | null = null;

  let shownRound = 0; // for per-round client resets
  let flashedRound = 0; // reveal flash fired for this round
  let builtCandidatesKey = "";
  let builtVoteKey = "";
  let builtRevealKey = "";

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    amParticipant =
      !ctx.isSpectator &&
      players.some((p) => p.playerId === ctx.selfPlayerId);
    if (built) return; // rebuild-safe: welcome is replayed on reconnect
    built = true;
    bannerEl.textContent = "SPY SIGNAL";
    subEl.textContent = "eyes on your own phone!";
  }

  function buildSymbols(candidates: string[]) {
    const key = candidates.join(",");
    if (key === builtCandidatesKey) return;
    builtCandidatesKey = key;
    symbolsEl.innerHTML = candidates
      .map(
        (s) => `<div class="spy-sym" data-sym="${escapeHtml(s)}">
          <img src="${spriteSrc(s)}" alt="" />
        </div>`,
      )
      .join("");
  }

  function highlightSymbol(symbol: string | null) {
    symbolsEl.querySelectorAll<HTMLElement>(".spy-sym").forEach((el) => {
      el.classList.toggle("spy-mine", el.dataset.sym === symbol);
    });
  }

  function buildVoteGrid() {
    const others = players.filter((p) => p.playerId !== ctx.selfPlayerId);
    const key = others.map((p) => p.playerId).join(",");
    if (key === builtVoteKey) return;
    builtVoteKey = key;
    voteEl.innerHTML = others
      .map(
        (p) => `<div class="spy-vote-cell" data-pid="${escapeHtml(p.playerId)}">
          <div class="spy-voted-badge" hidden>voted</div>
          <img src="${avatarSrc(p.avatarId)}" alt="" />
          <div class="spy-nick">${escapeHtml(p.nickname)}</div>
        </div>`,
      )
      .join("");
  }

  function updateVoteGrid(state: StateMsg) {
    const votedSet = new Set(state.votedIds);
    const connSet = new Set(state.connected);
    voteEl.querySelectorAll<HTMLElement>(".spy-vote-cell").forEach((el) => {
      const pid = el.dataset.pid!;
      el.classList.toggle(
        "spy-picked",
        myVoteRound === state.round && myVoteTarget === pid,
      );
      el.classList.toggle("spy-gone", !connSet.has(pid));
      const badge = el.querySelector<HTMLElement>(".spy-voted-badge");
      if (badge) badge.hidden = !votedSet.has(pid);
    });
  }

  // Vote taps: delegated, touchstart + mousedown, debounced.
  let lastTapAt = 0;
  let currentState: StateMsg | null = null;
  const tap = (e: Event) => {
    if (ctx.isSpectator || !amParticipant) return;
    const st = currentState;
    if (!st || st.phase !== "vote") return;
    const cell = (e.target as HTMLElement | null)?.closest?.(
      ".spy-vote-cell",
    ) as HTMLElement | null;
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapAt < 80) return;
    lastTapAt = now;
    const pid = cell.dataset.pid;
    if (!pid || pid === ctx.selfPlayerId) return;
    if (!st.connected.includes(pid)) return;
    myVoteRound = st.round;
    myVoteTarget = pid;
    ctx.send({ type: "vote", targetId: pid });
    updateVoteGrid(st);
  };
  voteEl.addEventListener("touchstart", tap, { passive: false });
  voteEl.addEventListener("mousedown", tap);

  function buildReveal(state: StateMsg) {
    const r = state.reveal;
    if (!r) return;
    const key = `${state.round}:${r.spyId}:${r.fled}`;
    if (key === builtRevealKey) return;
    builtRevealKey = key;

    const spyAvatar =
      players.find((p) => p.playerId === r.spyId)?.avatarId ?? "";
    const verdict = r.fled
      ? "the spy fled! +1 for everyone else"
      : r.caught
        ? "SPY CAUGHT! +3 for correct votes"
        : "spy got away · spy +6";
    const verdictBad = !r.caught && !r.fled;
    const tieNote = r.tie
      ? `<div class="spy-reveal-scored">vote was tied · accused picked at random</div>`
      : "";

    // Tally: votes per accused player.
    const counts = new Map<string, number>();
    for (const target of Object.values(r.votes)) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    const tallyText =
      counts.size > 0
        ? [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([pid, n]) => `${escapeHtml(nickOf(pid))}: ${n}`)
            .join(" · ")
        : "nobody voted";

    const scorers = Object.entries(r.awarded)
      .map(([pid, pts]) => `${escapeHtml(nickOf(pid))} +${pts}`)
      .join(" · ");

    revealEl.innerHTML = `
      <div class="spy-reveal-spy">
        ${spyAvatar ? `<img src="${avatarSrc(spyAvatar)}" alt="" />` : ""}
        <div class="spy-nick">${escapeHtml(r.spyNickname)} was the spy</div>
      </div>
      <div class="spy-reveal-syms">
        <div class="spy-rs"><img src="${spriteSrc(r.targetSymbol)}" alt="" /><span>crew signal</span></div>
        <div class="spy-rs"><img src="${spriteSrc(r.spySymbol)}" alt="" /><span>spy signal</span></div>
      </div>
      <div class="spy-reveal-verdict${verdictBad ? " spy-bad" : ""}">${escapeHtml(verdict)}</div>
      ${tieNote}
      <div class="spy-reveal-scored">votes — ${tallyText}</div>
      <div class="spy-reveal-scored">${scorers ? `scored: ${scorers}` : "nobody scored"}</div>
    `;
  }

  function applyState(msg: StateMsg) {
    currentState = msg;

    if (msg.round !== shownRound) {
      shownRound = msg.round;
      if (myVoteRound !== msg.round) myVoteTarget = null;
      builtRevealKey = "";
    }

    const phaseSecs = Math.max(
      0,
      Math.ceil((msg.phaseEndsAt - Date.now()) / 1000),
    );
    statusEl.textContent = statusLine(
      `round ${msg.round}/${msg.totalRounds}`,
      msg.phase,
      formatRemaining(msg.deadlineAt),
    );

    if (amParticipant) {
      const pts = msg.points[ctx.selfPlayerId] ?? 0;
      ctx.setMatchScore(`you: ${pts} pts`);
    } else {
      ctx.setMatchScore(null);
    }

    const mySecret = secretByRound.get(msg.round) ?? null;
    const missedPeek = amParticipant && mySecret === null;

    buildSymbols(msg.candidates);

    const showSymbols = msg.phase === "peek" || msg.phase === "discuss";
    symbolsEl.hidden = !showSymbols;
    voteEl.hidden = msg.phase !== "vote";
    revealEl.hidden = !(
      (msg.phase === "reveal" || msg.phase === "ended") &&
      msg.reveal !== null
    );
    countEl.hidden = !(msg.phase === "discuss" || msg.phase === "vote");
    if (!countEl.hidden) countEl.textContent = String(phaseSecs);

    if (msg.phase === "peek") {
      if (!amParticipant) {
        highlightSymbol(null);
        bannerEl.textContent = "PEEK TIME";
        subEl.textContent = "players are memorizing their signals…";
      } else if (mySecret) {
        highlightSymbol(mySecret);
        bannerEl.textContent = "YOUR SIGNAL";
        subEl.textContent = "memorize your signal · don't show your phone!";
      } else {
        highlightSymbol(null);
        bannerEl.textContent = "GET READY";
        subEl.textContent = "your signal is coming…";
      }
    } else if (msg.phase === "discuss") {
      highlightSymbol(null); // nothing revealing on screen
      bannerEl.textContent = "TALK!";
      subEl.textContent = !amParticipant
        ? "listen in — who sounds shifty?"
        : missedPeek
          ? "you missed the peek — bluff your way through!"
          : "Who saw a different signal?";
    } else if (msg.phase === "vote") {
      buildVoteGrid();
      updateVoteGrid(msg);
      bannerEl.textContent = "VOTE!";
      subEl.textContent = !amParticipant
        ? "players are voting…"
        : missedPeek
          ? "you missed the peek — tap your best guess (or abstain)"
          : "tap who you think the spy is · you can change it";
    } else if (msg.phase === "reveal" || msg.phase === "ended") {
      buildReveal(msg);
      const r = msg.reveal;
      bannerEl.textContent = "THE REVEAL";
      subEl.textContent =
        msg.phase === "ended" ? "final scores are in!" : "next round soon…";
      if (r && flashedRound !== msg.round) {
        flashedRound = msg.round;
        flash.flash(r.fled ? "SPY FLED!" : r.caught ? "SPY CAUGHT!" : "SPY WINS!");
      }
    }
  }

  function applySecret(msg: SecretMsg) {
    if (ctx.isSpectator) return;
    if (!Number.isFinite(msg.round) || typeof msg.symbol !== "string") return;
    secretByRound.set(msg.round, msg.symbol); // idempotent
  }

  return {
    onMessage(msg) {
      if (msg.type === "welcome") applyWelcome(msg as unknown as WelcomeMsg);
      else if (msg.type === "state") applyState(msg as unknown as StateMsg);
      else if (msg.type === "secret") applySecret(msg as unknown as SecretMsg);
    },
    unmount() {
      flash.destroy();
      ctx.container.innerHTML = "";
    },
  };
}

const SpySignalClient: MiniGameClientDefinition = {
  id: "spy-signal",
  controlsHint: "peek your secret signal, talk it out loud, then vote the spy!",
  createMatch: createSpySignalMatchClient,
};

registerMiniGameClient(SpySignalClient);

export default SpySignalClient;
