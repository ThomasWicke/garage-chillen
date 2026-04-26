// Lobby route — owns the WebSocket connection for the lifetime of the route.
// Layout:
//   ┌────────────────────────────────────┐
//   │ session toolbar (persistent)       │
//   ├────────────────────────────────────┤
//   │ scene (lobby/preparing/mg/results) │
//   │  ↑ this region swaps based on the  │
//   │    server-driven lobby state       │
//   └────────────────────────────────────┘

import { ensureIdentity } from "../identity";
import { LobbyConnection, type ConnectionStatus } from "../socket";
import { renderLobbyView } from "../ui/lobby-view";
import { renderPreparingView } from "../ui/preparing-view";
import { renderRoundResultsView } from "../ui/round-results-view";
import { renderSessionToolbar } from "../ui/session-toolbar";
import { getMiniGameClient } from "../minigames";
import "../minigames"; // ensure self-registration of all mini-game clients
import type { MiniGameClientSession } from "../minigames/types";
import type {
  LobbyState,
  MiniGameInfo,
  PublicBracket,
  PublicPlayer,
  RoundResult,
  ServerToClient,
} from "../../../party/protocol";

type ViewState = {
  code: string;
  status: ConnectionStatus;
  selfPlayerId: string | null;
  players: PublicPlayer[];
  gmPlayerId: string | null;
  gmGraceUntil: number | null;
  lobbyState: LobbyState;
  availableMinigames: MiniGameInfo[];
  activeMinigameId: string | null;
  activeParticipants: string[];
  prepareCountdownEndsAt: number;
  lastResult: RoundResult | null;
  sessionScores: Record<string, number>;
  /** Mini-game-pushed match score, e.g. "3 – 1". Cleared on teardown. */
  matchScore: string | null;
  /** Live bracket snapshot (1v1 mini-games with bracket layer). */
  bracket: PublicBracket | null;
  /** Server-side timestamp; while > Date.now(), no match is active. */
  intermissionUntil: number | null;
};

export function renderLobby(rawCode: string): () => void {
  const code = rawCode.toUpperCase();
  const identity = ensureIdentity();
  const app = document.getElementById("app")!;

  // One-time scaffold — toolbar on top, scene below.
  app.innerHTML = `
    <div class="session-toolbar" id="toolbar"></div>
    <div class="scene" id="scene"></div>
  `;
  const toolbarEl = app.querySelector<HTMLElement>("#toolbar")!;
  const sceneEl = app.querySelector<HTMLElement>("#scene")!;

  const state: ViewState = {
    code,
    status: "connecting",
    selfPlayerId: null,
    players: [],
    gmPlayerId: null,
    gmGraceUntil: null,
    lobbyState: "idle",
    availableMinigames: [],
    activeMinigameId: null,
    activeParticipants: [],
    prepareCountdownEndsAt: 0,
    lastResult: null,
    sessionScores: {},
    matchScore: null,
    bracket: null,
    intermissionUntil: null,
  };

  let activeSession: MiniGameClientSession | null = null;
  let activeSessionMinigameId: string | null = null;

  function teardownSession() {
    if (activeSession) {
      try {
        activeSession.unmount();
      } catch (e) {
        console.error("unmount error", e);
      }
      activeSession = null;
      activeSessionMinigameId = null;
    }
    state.matchScore = null;
  }

  function rerender() {
    const isGm = !!state.selfPlayerId && state.gmPlayerId === state.selfPlayerId;

    // Toolbar always renders.
    renderSessionToolbar(state, toolbarEl);

    if (state.lobbyState === "idle") {
      teardownSession();
      renderLobbyView(state, sceneEl, {
        onStartRound: (minigameId) => conn.send({ scope: "lobby", type: "start-round", minigameId }),
      });
      return;
    }

    if (state.lobbyState === "preparing") {
      teardownSession();
      const mg = state.availableMinigames.find((m) => m.id === state.activeMinigameId);
      renderPreparingView(
        { minigame: mg ?? null, countdownEndsAt: state.prepareCountdownEndsAt },
        sceneEl,
      );
      return;
    }

    if (state.lobbyState === "playing") {
      const minigameId = state.activeMinigameId;
      if (!minigameId) return;
      if (activeSessionMinigameId !== minigameId) {
        teardownSession();
        const def = getMiniGameClient(minigameId);
        if (!def) {
          console.error(`No client for mini-game ${minigameId}`);
          return;
        }
        sceneEl.innerHTML = `
          <div class="minigame-mount" id="mg-mount"></div>
          <div class="intermission-overlay" id="intermission" hidden></div>
        `;
        const mount = sceneEl.querySelector<HTMLElement>("#mg-mount")!;
        activeSession = def.createSession({
          container: mount,
          selfPlayerId: state.selfPlayerId ?? "",
          participants: state.activeParticipants,
          allPlayers: state.players,
          send: (m) => conn.send({ scope: "minigame", ...m }),
          setMatchScore: (text) => {
            state.matchScore = text;
            renderSessionToolbar(state, toolbarEl);
          },
        });
        activeSessionMinigameId = minigameId;
      }
      renderIntermissionOverlay(state, sceneEl);
      return;
    }

    if (state.lobbyState === "round-results" && state.lastResult) {
      teardownSession();
      renderRoundResultsView(
        {
          result: state.lastResult,
          players: state.players,
          selfPlayerId: state.selfPlayerId,
          isGm,
        },
        sceneEl,
        {
          onBackToLobby: () => conn.send({ scope: "lobby", type: "back-to-lobby" }),
        },
      );
      return;
    }
  }

  rerender();

  const conn = new LobbyConnection(code.toLowerCase(), identity, {
    onStatus: (status: ConnectionStatus) => {
      state.status = status;
      rerender();
    },
    onMessage: (msg: ServerToClient) => {
      if (msg.scope === "presence" && msg.type === "welcome") {
        state.selfPlayerId = msg.selfPlayerId;
      } else if (msg.scope === "presence" && msg.type === "player-list") {
        state.players = msg.players;
        state.gmPlayerId = msg.gmPlayerId;
        state.gmGraceUntil = msg.gmGraceUntil;
      } else if (msg.scope === "lobby" && msg.type === "available-minigames") {
        state.availableMinigames = msg.minigames;
      } else if (msg.scope === "lobby" && msg.type === "session-state") {
        state.sessionScores = msg.scores;
      } else if (msg.scope === "lobby" && msg.type === "state") {
        state.lobbyState = msg.state;
        if (msg.state === "preparing") {
          state.activeMinigameId = msg.minigameId;
          state.activeParticipants = msg.participants;
          state.prepareCountdownEndsAt = msg.countdownEndsAt;
          state.bracket = null;
          state.intermissionUntil = null;
        } else if (msg.state === "playing") {
          state.activeMinigameId = msg.minigameId;
          state.activeParticipants = msg.participants;
          state.bracket = msg.bracket ?? null;
          state.intermissionUntil = msg.intermissionUntil ?? null;
          // Clear last match's score when a new match begins or during the
          // intermission (the next match's first state msg will set it again).
          if (msg.intermissionUntil) state.matchScore = null;
        } else if (msg.state === "round-results") {
          state.lastResult = msg.result;
          state.activeMinigameId = null;
          state.activeParticipants = [];
          state.bracket = null;
          state.intermissionUntil = null;
        } else {
          state.activeMinigameId = null;
          state.activeParticipants = [];
          state.lastResult = null;
          state.bracket = null;
          state.intermissionUntil = null;
        }
      } else if (msg.scope === "minigame") {
        if (activeSession) activeSession.onMessage(msg);
      }
      rerender();
    },
  });

  const interval = setInterval(() => {
    if (state.lobbyState === "preparing") {
      rerender();
    } else if (
      state.lobbyState === "playing" &&
      state.intermissionUntil !== null &&
      state.intermissionUntil > Date.now()
    ) {
      rerender();
    } else if (state.gmGraceUntil !== null && state.gmGraceUntil > Date.now()) {
      rerender();
    }
  }, 500);

  return () => {
    clearInterval(interval);
    teardownSession();
    conn.close();
  };
}

function renderIntermissionOverlay(
  state: ViewState,
  sceneEl: HTMLElement,
): void {
  const overlay = sceneEl.querySelector<HTMLElement>("#intermission");
  if (!overlay) return;
  const active =
    state.intermissionUntil !== null &&
    state.intermissionUntil > Date.now();
  if (!active) {
    overlay.hidden = true;
    overlay.innerHTML = "";
    return;
  }
  const remaining = Math.max(
    0,
    Math.ceil((state.intermissionUntil! - Date.now()) / 1000),
  );

  // Identify the next match by reading the bracket: first match with both
  // slots filled and no winner yet.
  let nextLine = "";
  if (state.bracket) {
    const next = state.bracket.matches.find(
      (m) => m.winner === null && m.a !== null && m.b !== null,
    );
    if (next) {
      const aNick = nick(state, next.a!);
      const bNick = nick(state, next.b!);
      nextLine = `${aNick} vs ${bNick}`;
    }
  }

  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="intermission-card">
      <div class="intermission-title">Next match in</div>
      <div class="intermission-countdown">${remaining}</div>
      ${nextLine ? `<div class="intermission-next">${escapeHtml(nextLine)}</div>` : ""}
    </div>
  `;
}

function nick(state: ViewState, playerId: string): string {
  return state.players.find((p) => p.playerId === playerId)?.nickname ?? "?";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
