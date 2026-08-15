// Signal Imposter client (module id "spy-signal"). Pure DOM. The game
// happens IN THE ROOM — the phone only shows your secret during "peek"
// (crew: the signal symbol · imposter: "you're the imposter", no symbol),
// deliberately shows nothing revealing during "discuss", collects your
// vote (crew: an avatar · imposter: a symbol guess) during "vote", and
// shows a compact one-screen reveal at the end.
//
// Secrets arrive via per-player `secret` messages (re-sent ~500ms during
// peek; applied idempotently). A player who reconnects after peek never
// gets one and sees "you missed the peek".

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
  scoring: {
    groupBonus: number;
    rightVote: number;
    imposterEscape: number;
    imposterGuess: number;
  };
  players: { playerId: string; nickname: string; avatarId: string }[];
};

type Reveal = {
  imposterId: string;
  imposterNickname: string;
  targetSymbol: string;
  imposterGuess: string | null;
  guessRight: boolean;
  accusedId: string | null;
  caught: boolean;
  tie: boolean;
  fled: boolean;
  votes: Record<string, string>;
  awarded: Record<string, number>;
};

type StateMsg = {
  type: "state";
  phase: Phase;
  candidates: string[];
  phaseEndsAt: number;
  deadlineAt: number;
  /** Server time when the whole match ends (all phases chained from GO). */
  endsAt?: number;
  points: Record<string, number>;
  votedIds: string[];
  connected: string[];
  reveal: Reveal | null;
};

type SecretMsg = { type: "secret"; imposter: boolean; symbol: string | null };

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

function createSignalImposterMatchClient(
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
          overflow: hidden;
        }
        .spy-root [hidden] { display: none !important; }
        .spy-status { font-size: 13px; color: #9a9aa5; }
        .spy-banner {
          font-size: clamp(20px, 6.5vw, 30px);
          font-weight: 800;
          color: #abdd64;
          min-height: 1.3em;
          line-height: 1.2;
        }
        .spy-banner.spy-imp { color: #e0596a; }
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
          -webkit-tap-highlight-color: transparent;
        }
        .spy-symbols.spy-tappable .spy-sym { cursor: pointer; }
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

        /* Reveal — one screen, no scrolling: small avatar line, verdict,
           ONE row of small symbols, then compact chip rows. */
        .spy-reveal {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          width: min(360px, 94%);
          background: #14141f;
          border: 3px solid #2a2a3a;
          border-radius: 16px;
          padding: 12px 10px;
          animation: spy-pop 0.35s ease-out;
        }
        @keyframes spy-pop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .spy-reveal-imp {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 15px;
          font-weight: 700;
        }
        .spy-reveal-imp img { width: 36px; height: 36px; border-radius: 8px; }
        .spy-reveal-verdict {
          font-size: 17px;
          font-weight: 800;
          color: #abdd64;
          line-height: 1.2;
        }
        .spy-reveal-verdict.spy-bad { color: #e0596a; }
        .spy-reveal-syms {
          display: flex;
          gap: 8px;
          justify-content: center;
          align-items: flex-end;
        }
        .spy-reveal-syms .spy-rs {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          font-size: 10px;
          color: #9a9aa5;
          padding: 4px;
          border: 2px solid transparent;
          border-radius: 10px;
          min-width: 52px;
        }
        .spy-reveal-syms .spy-rs.spy-target { border-color: #abdd64; color: #abdd64; }
        .spy-reveal-syms .spy-rs.spy-guess-wrong { border-color: #e0596a; color: #e0596a; }
        .spy-reveal-syms img {
          width: 36px;
          height: 36px;
          image-rendering: pixelated;
        }
        .spy-chips {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 4px 6px;
          font-size: 12px;
          line-height: 1.2;
        }
        .spy-chip {
          background: #1e1e2c;
          border-radius: 6px;
          padding: 3px 7px;
          white-space: nowrap;
        }
        .spy-chip.spy-me { outline: 1px solid #abdd64; }
        .spy-chip .spy-plus { color: #abdd64; font-weight: 700; }
        .spy-chip .spy-zero { color: #9a9aa5; }
        .spy-reveal-note { font-size: 11px; color: #9a9aa5; }
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
  let scoring: WelcomeMsg["scoring"] = {
    groupBonus: 2,
    rightVote: 2,
    imposterEscape: 5,
    imposterGuess: 2,
  };
  let built = false;
  let amParticipant = false;

  /** My secret: null = not received (yet). Idempotent; re-sent by server. */
  let secret: SecretMsg | null = null;
  /** Local record of own pick (broadcasts never say who-for-whom). */
  let myVoteTarget: string | null = null;
  let myGuess: string | null = null;

  let flashed = false;
  let builtCandidatesKey = "";
  let builtVoteKey = "";
  let builtReveal = false;

  function nickOf(pid: string | null): string {
    if (!pid) return "?";
    return players.find((p) => p.playerId === pid)?.nickname ?? "?";
  }

  function applyWelcome(msg: WelcomeMsg) {
    players = msg.players;
    if (msg.scoring) scoring = msg.scoring;
    amParticipant =
      !ctx.isSpectator &&
      players.some((p) => p.playerId === ctx.selfPlayerId);
    if (built) return; // rebuild-safe: welcome is replayed on reconnect
    built = true;
    bannerEl.textContent = "SIGNAL IMPOSTER";
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
      el.classList.toggle("spy-picked", myVoteTarget === pid);
      el.classList.toggle("spy-gone", !connSet.has(pid));
      const badge = el.querySelector<HTMLElement>(".spy-voted-badge");
      if (badge) badge.hidden = !votedSet.has(pid);
    });
  }

  let currentState: StateMsg | null = null;
  const amImposter = () => secret?.imposter === true;

  // Crew vote taps: delegated, touchstart + mousedown, debounced.
  let lastTapAt = 0;
  const voteTap = (e: Event) => {
    if (ctx.isSpectator || !amParticipant || amImposter()) return;
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
    myVoteTarget = pid;
    ctx.send({ type: "vote", targetId: pid });
    updateVoteGrid(st);
  };
  voteEl.addEventListener("touchstart", voteTap, { passive: false });
  voteEl.addEventListener("mousedown", voteTap);

  // Imposter guess taps on the symbol grid (vote phase only).
  const guessTap = (e: Event) => {
    if (ctx.isSpectator || !amParticipant || !amImposter()) return;
    const st = currentState;
    if (!st || st.phase !== "vote") return;
    const cell = (e.target as HTMLElement | null)?.closest?.(".spy-sym") as
      | HTMLElement
      | null;
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapAt < 80) return;
    lastTapAt = now;
    const sym = cell.dataset.sym;
    if (!sym || !st.candidates.includes(sym)) return;
    myGuess = sym;
    ctx.send({ type: "guess", symbol: sym });
    highlightSymbol(sym);
  };
  symbolsEl.addEventListener("touchstart", guessTap, { passive: false });
  symbolsEl.addEventListener("mousedown", guessTap);

  function buildReveal(state: StateMsg) {
    const r = state.reveal;
    if (!r || builtReveal) return;
    builtReveal = true;

    const impAvatar =
      players.find((p) => p.playerId === r.imposterId)?.avatarId ?? "";
    const verdict = r.fled
      ? "the imposter fled! +1 for everyone else"
      : r.caught
        ? "IMPOSTER CAUGHT!"
        : r.tie
          ? "tied vote — the imposter slips away!"
          : "the imposter got away!";
    const verdictBad = !r.caught && !r.fled;

    // ONE row of small symbols: signal highlighted, wrong guess marked.
    const symsRow = state.candidates
      .map((s) => {
        const isTarget = s === r.targetSymbol;
        const isGuess = r.imposterGuess === s;
        const cls = isTarget
          ? "spy-target"
          : isGuess
            ? "spy-guess-wrong"
            : "";
        const label = isTarget
          ? isGuess
            ? "signal ✓ guessed"
            : "signal"
          : isGuess
            ? "imposter's guess"
            : "";
        return `<div class="spy-rs ${cls}"><img src="${spriteSrc(s)}" alt="" /><span>${label}</span></div>`;
      })
      .join("");
    const guessNote = r.fled
      ? ""
      : r.imposterGuess === null
        ? `<div class="spy-reveal-note">imposter didn't guess the signal</div>`
        : "";

    // Points: every participant, one chip each, mine outlined.
    const pointChips = players
      .map((p) => {
        const pts = r.awarded[p.playerId] ?? 0;
        const me = p.playerId === ctx.selfPlayerId;
        const isImp = p.playerId === r.imposterId;
        return `<span class="spy-chip${me ? " spy-me" : ""}">${escapeHtml(p.nickname)}${isImp ? " 🕵" : ""} <span class="${pts > 0 ? "spy-plus" : "spy-zero"}">+${pts}</span></span>`;
      })
      .join("");

    // Tally: votes per accused player.
    const counts = new Map<string, number>();
    for (const target of Object.values(r.votes)) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    const tallyChips =
      counts.size > 0
        ? [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(
              ([pid, n]) =>
                `<span class="spy-chip">${escapeHtml(nickOf(pid))} ${n}×</span>`,
            )
            .join("")
        : `<span class="spy-chip spy-zero">nobody voted</span>`;

    revealEl.innerHTML = `
      <div class="spy-reveal-imp">
        ${impAvatar ? `<img src="${avatarSrc(impAvatar)}" alt="" />` : ""}
        <span>${escapeHtml(r.imposterNickname)} was the imposter</span>
      </div>
      <div class="spy-reveal-verdict${verdictBad ? " spy-bad" : ""}">${escapeHtml(verdict)}</div>
      <div class="spy-reveal-syms">${symsRow}</div>
      ${guessNote}
      <div class="spy-chips">${pointChips}</div>
      <div class="spy-reveal-note">votes</div>
      <div class="spy-chips">${tallyChips}</div>
    `;
  }

  function applyState(msg: StateMsg) {
    currentState = msg;

    const phaseSecs = Math.max(
      0,
      Math.ceil((msg.phaseEndsAt - Date.now()) / 1000),
    );
    // Clock counts to the REAL end (peek+discuss+vote+reveal, chained from
    // GO) — not the safety-net deadline, which used to read a minute long.
    statusEl.textContent = statusLine(
      "signal imposter",
      msg.phase,
      formatRemaining(msg.endsAt ?? msg.deadlineAt),
    );

    if (amParticipant) {
      const pts = msg.points[ctx.selfPlayerId] ?? 0;
      ctx.setMatchScore(`you: ${pts} pts`);
    } else {
      ctx.setMatchScore(null);
    }

    const haveSecret = secret !== null;
    const imposter = amImposter();
    const missedPeek = amParticipant && !haveSecret;

    buildSymbols(msg.candidates);

    const showSymbols =
      msg.phase === "peek" ||
      msg.phase === "discuss" ||
      (msg.phase === "vote" && imposter);
    symbolsEl.hidden = !showSymbols;
    symbolsEl.classList.toggle("spy-tappable", msg.phase === "vote" && imposter);
    voteEl.hidden = !(msg.phase === "vote" && !imposter);
    revealEl.hidden = !(
      (msg.phase === "reveal" || msg.phase === "ended") &&
      msg.reveal !== null
    );
    countEl.hidden = !(msg.phase === "discuss" || msg.phase === "vote");
    if (!countEl.hidden) countEl.textContent = String(phaseSecs);
    bannerEl.classList.toggle("spy-imp", imposter && msg.phase !== "reveal" && msg.phase !== "ended");

    if (msg.phase === "peek") {
      if (!amParticipant) {
        highlightSymbol(null);
        bannerEl.textContent = "PEEK TIME";
        subEl.textContent = "";
      } else if (imposter) {
        highlightSymbol(null);
        bannerEl.textContent = "YOU'RE THE IMPOSTER";
        subEl.textContent = "the others see one of these";
      } else if (secret?.symbol) {
        highlightSymbol(secret.symbol);
        bannerEl.textContent = "THE SIGNAL";
        subEl.textContent = "";
      } else {
        highlightSymbol(null);
        bannerEl.textContent = "GET READY";
        subEl.textContent = "";
      }
    } else if (msg.phase === "discuss") {
      highlightSymbol(null); // nothing revealing on screen
      bannerEl.textContent = "TALK!";
      subEl.textContent = amParticipant && missedPeek ? "you missed the peek" : "";
    } else if (msg.phase === "vote") {
      if (imposter) {
        highlightSymbol(myGuess);
        bannerEl.textContent = "GUESS THE SIGNAL";
        subEl.textContent = "";
      } else {
        buildVoteGrid();
        updateVoteGrid(msg);
        bannerEl.textContent = "VOTE!";
        subEl.textContent = amParticipant && missedPeek ? "you missed the peek" : "";
      }
    } else if (msg.phase === "reveal" || msg.phase === "ended") {
      buildReveal(msg);
      const r = msg.reveal;
      bannerEl.textContent = "THE REVEAL";
      // Scoring explainer in one line — "how does the scoring work" was
      // the #1 playtest question.
      const sc = scoring;
      subEl.textContent = !r || r.fled
        ? ""
        : r.caught
          ? `crew +${sc.groupBonus} · right vote +${sc.rightVote} · imposter +${sc.imposterGuess} if signal guessed`
          : `imposter +${sc.imposterEscape} (+${sc.imposterGuess} signal) · right vote +${sc.rightVote}`;
      if (r && !flashed) {
        flashed = true;
        flash.flash(
          r.fled ? "IMPOSTER FLED!" : r.caught ? "CAUGHT!" : "IMPOSTER WINS!",
        );
      }
    }
  }

  function applySecret(msg: SecretMsg) {
    if (ctx.isSpectator) return;
    if (typeof msg.imposter !== "boolean") return;
    secret = { type: "secret", imposter: msg.imposter, symbol: msg.symbol ?? null };
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

const SignalImposterClient: MiniGameClientDefinition = {
  id: "spy-signal",
  controlsHint:
    "everyone sees the signal except the imposter — talk it out, then vote (the imposter guesses the signal instead)",
  createMatch: createSignalImposterMatchClient,
};

registerMiniGameClient(SignalImposterClient);

export default SignalImposterClient;
