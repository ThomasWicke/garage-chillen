// Lobby route — owns the WebSocket connection for the lifetime of the route.
// Layout:
//   ┌────────────────────────────────────┐
//   │ session toolbar (persistent)       │
//   ├────────────────────────────────────┤
//   │ scene (lobby/preparing/gm/results) │
//   │  ↑ this region swaps based on the  │
//   │    server-driven lobby state       │
//   └────────────────────────────────────┘
//
// During "playing" the scene region is owned by the active gamemode client
// (e.g. tournament), which renders the bracket overlay and mounts the per-
// match client when the local player is in a match.

import { ensureIdentity, nextAvatarId, saveIdentity } from "../identity";
import { getGamemodeClient } from "../gamemodes";
import "../gamemodes"; // ensure gamemode client self-registration
import type { GamemodeClientSession } from "../gamemodes/types";
import { LobbyConnection, type ConnectionStatus } from "../socket";
import { openGamePickerDrawer } from "../ui/game-picker-drawer";
import { renderLobbyView } from "../ui/lobby-view";
import { renderPreparingView } from "../ui/preparing-view";
import { renderRoundResultsView } from "../ui/round-results-view";
import { renderSessionToolbar } from "../ui/session-toolbar";
import { getMiniGameClient } from "../minigames";
import "../minigames"; // ensure mini-game client self-registration
import type {
  LobbyState,
  MiniGameInfo,
  PublicPlayer,
  RoundResult,
  SequencePublicState,
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
  activeGamemodeId: string | null;
  prepareCountdownEndsAt: number;
  lastResult: RoundResult | null;
  /** Server time (ms) when round-results auto-dismisses; 0 outside of round-results state. */
  resultsDismissAt: number;
  sessionScores: Record<string, number>;
  /** Mini-game-pushed match score, e.g. "3 – 1". Cleared on teardown. */
  matchScore: string | null;
  /** Active shuffle sequence (server-authoritative), or null. */
  sequence: SequencePublicState | null;
  /** True while the user is editing their nickname inline. */
  editingNickname: boolean;
  /** Local draft of the nickname during edit. */
  nicknameDraft: string;
  /** Last edit-rejection (cleared on next successful edit / next player-list / timer). */
  editError: { field: "nickname" | "avatar"; reason: string } | null;
  editErrorTimer: ReturnType<typeof setTimeout> | null;
};

export function renderLobby(rawCode: string): () => void {
  const code = rawCode.toUpperCase();
  const identity = ensureIdentity();
  const app = document.getElementById("app")!;

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
    activeGamemodeId: null,
    prepareCountdownEndsAt: 0,
    lastResult: null,
    resultsDismissAt: 0,
    sessionScores: {},
    matchScore: null,
    sequence: null,
    editingNickname: false,
    nicknameDraft: "",
    editError: null,
    editErrorTimer: null,
  };

  function isEditEligible(): boolean {
    if (state.lobbyState !== "idle") return false;
    if (!state.sequence) return true;
    return state.sequence.paused;
  }

  function setEditError(
    field: "nickname" | "avatar",
    reason: string,
  ) {
    if (state.editErrorTimer) clearTimeout(state.editErrorTimer);
    state.editError = { field, reason };
    state.editErrorTimer = setTimeout(() => {
      state.editError = null;
      state.editErrorTimer = null;
      rerender();
    }, 3500);
  }

  function clearEditError() {
    if (state.editErrorTimer) {
      clearTimeout(state.editErrorTimer);
      state.editErrorTimer = null;
    }
    state.editError = null;
  }

  function commitDraftNickname() {
    if (!state.editingNickname) return;
    const draft = state.nicknameDraft.trim();
    state.editingNickname = false;
    if (!draft) {
      // Treat empty as cancel (no-op).
      state.nicknameDraft = "";
      return;
    }
    const self = state.players.find((p) => p.playerId === state.selfPlayerId);
    if (self && draft === self.nickname) {
      // Unchanged → just close.
      state.nicknameDraft = "";
      return;
    }
    state.nicknameDraft = "";
    conn.send({ scope: "presence", type: "set-nickname", nickname: draft });
  }

  function cancelEditNickname() {
    state.editingNickname = false;
    state.nicknameDraft = "";
  }

  let drawerClose: (() => void) | null = null;

  let activeGamemodeSession: GamemodeClientSession | null = null;
  let activeGamemodeKey: string | null = null; // `${gamemodeId}:${minigameId}`

  function teardownGamemode() {
    if (activeGamemodeSession) {
      try {
        activeGamemodeSession.unmount();
      } catch (e) {
        console.error("gamemode unmount error", e);
      }
      activeGamemodeSession = null;
      activeGamemodeKey = null;
    }
    state.matchScore = null;
  }

  function rerender() {
    const isGm = !!state.selfPlayerId && state.gmPlayerId === state.selfPlayerId;

    renderSessionToolbar(state, toolbarEl);

    if (state.lobbyState === "idle") {
      teardownGamemode();
      const editable = isEditEligible();
      renderLobbyView(
        {
          selfPlayerId: state.selfPlayerId,
          players: state.players,
          gmPlayerId: state.gmPlayerId,
          availableMinigames: state.availableMinigames,
          sequence: state.sequence ?? undefined,
          editable,
          editError: state.editError,
          editingNickname: state.editingNickname && editable,
          nicknameDraft: state.nicknameDraft,
        },
        sceneEl,
        {
          onPickMinigame: () => {
            if (drawerClose) return; // already open
            const connectedCount = state.players.filter((p) => p.connected).length;
            drawerClose = openGamePickerDrawer({
              minigames: state.availableMinigames,
              connectedCount,
              onPick: (minigameId) =>
                conn.send({ scope: "lobby", type: "start-round", minigameId }),
              onClose: () => {
                drawerClose = null;
              },
            });
          },
          onStartShuffle: () =>
            conn.send({ scope: "lobby", type: "start-shuffle" }),
          onPauseSequence: () =>
            conn.send({ scope: "lobby", type: "pause-sequence" }),
          onResumeSequence: () =>
            conn.send({ scope: "lobby", type: "resume-sequence" }),
          onEndSequence: () =>
            conn.send({ scope: "lobby", type: "end-sequence" }),
          onCycleAvatar: () => {
            const self = state.players.find(
              (p) => p.playerId === state.selfPlayerId,
            );
            if (!self) return;
            const taken = new Set(
              state.players
                .filter((p) => p.playerId !== state.selfPlayerId)
                .map((p) => p.avatarId),
            );
            const next = nextAvatarId(
              self.avatarId,
              taken,
              state.players.length,
            );
            if (next === self.avatarId) return;
            // Optimistic local update; server's player-list will confirm.
            self.avatarId = next;
            conn.send({
              scope: "presence",
              type: "set-avatar",
              avatarId: next,
            });
            rerender();
          },
          onBeginEditNickname: () => {
            const self = state.players.find(
              (p) => p.playerId === state.selfPlayerId,
            );
            if (!self) return;
            state.editingNickname = true;
            state.nicknameDraft = self.nickname;
            clearEditError();
            rerender();
          },
          onDraftNickname: (value) => {
            state.nicknameDraft = value;
            // Don't rerender on every keystroke; the input owns its value.
          },
          onCommitNickname: (value) => {
            // Sync the input's current value into the draft, then commit.
            // Reading directly from the input avoids races with the input
            // event listener.
            state.nicknameDraft = value;
            commitDraftNickname();
            rerender();
          },
          onCancelNickname: () => {
            cancelEditNickname();
            rerender();
          },
        },
      );
      return;
    }

    // Outside of the idle lobby view, force-commit any in-progress nickname
    // edit (per spec: when state changes, take whatever is in the input).
    if (state.editingNickname) {
      commitDraftNickname();
    }

    if (state.lobbyState === "preparing") {
      teardownGamemode();
      const mg = state.availableMinigames.find(
        (m) => m.id === state.activeMinigameId,
      );
      renderPreparingView(
        { minigame: mg ?? null, countdownEndsAt: state.prepareCountdownEndsAt },
        sceneEl,
      );
      return;
    }

    if (state.lobbyState === "playing") {
      const minigameId = state.activeMinigameId;
      const gamemodeId = state.activeGamemodeId;
      if (!minigameId || !gamemodeId) return;
      const key = `${gamemodeId}:${minigameId}`;
      if (activeGamemodeKey !== key) {
        teardownGamemode();
        const gmDef = getGamemodeClient(gamemodeId);
        if (!gmDef) {
          console.error(`No client for gamemode ${gamemodeId}`);
          return;
        }
        const mgDef = getMiniGameClient(minigameId);
        if (!mgDef) {
          console.error(`No client for mini-game ${minigameId}`);
          return;
        }
        const mgInfo = state.availableMinigames.find((m) => m.id === minigameId);
        sceneEl.innerHTML = `<div class="gamemode-mount" id="gm-mount"></div>`;
        const mount = sceneEl.querySelector<HTMLElement>("#gm-mount")!;
        activeGamemodeSession = gmDef.createSession({
          container: mount,
          selfPlayerId: state.selfPlayerId ?? "",
          lobbyPlayers: state.players.map((p) => ({
            playerId: p.playerId,
            nickname: p.nickname,
            avatarId: p.avatarId,
          })),
          miniGame: mgDef,
          miniGameDisplayName: mgInfo?.displayName ?? minigameId,
          sendGamemode: (m) =>
            conn.send({
              scope: "minigame",
              target: "gamemode",
              ...m,
            }),
          sendMatch: (matchId, m) =>
            conn.send({
              scope: "minigame",
              target: "match",
              matchId,
              ...m,
            }),
          setMatchScore: (text) => {
            state.matchScore = text;
            renderSessionToolbar(state, toolbarEl);
          },
        });
        activeGamemodeKey = key;
      }
      return;
    }

    if (state.lobbyState === "round-results" && state.lastResult) {
      teardownGamemode();
      renderRoundResultsView(
        {
          result: state.lastResult,
          players: state.players,
          selfPlayerId: state.selfPlayerId,
          isGm,
          dismissAt: state.resultsDismissAt,
        },
        sceneEl,
        {
          onBackToLobby: () =>
            conn.send({ scope: "lobby", type: "back-to-lobby" }),
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
        // Persist server-truth identity (name + avatar) to localStorage so
        // the next visit defaults to the latest values.
        const self = state.players.find(
          (p) => p.playerId === state.selfPlayerId,
        );
        if (self) {
          saveIdentity({
            playerId: identity.playerId,
            nickname: self.nickname,
            avatarId: self.avatarId,
          });
        }
      } else if (msg.scope === "presence" && msg.type === "edit-rejected") {
        // Server rejected an in-lobby edit. Show inline reason; the next
        // player-list (already broadcast or coming) reverts any optimistic UI.
        const reasonText =
          msg.field === "nickname"
            ? msg.reason === "duplicate"
              ? "name already taken"
              : msg.reason === "invalid"
                ? "invalid name"
                : "can't change right now"
            : msg.reason === "not-allowed"
              ? "can't change right now"
              : "avatar unavailable";
        setEditError(msg.field, reasonText);
      } else if (msg.scope === "lobby" && msg.type === "available-minigames") {
        state.availableMinigames = msg.minigames;
      } else if (msg.scope === "lobby" && msg.type === "session-state") {
        state.sessionScores = msg.scores;
      } else if (msg.scope === "lobby" && msg.type === "state") {
        state.lobbyState = msg.state;
        state.sequence = msg.sequence ?? null;
        if (msg.state === "preparing") {
          state.activeMinigameId = msg.minigameId;
          state.activeGamemodeId = null;
          state.prepareCountdownEndsAt = msg.countdownEndsAt;
        } else if (msg.state === "playing") {
          state.activeMinigameId = msg.minigameId;
          state.activeGamemodeId = msg.gamemodeId;
        } else if (msg.state === "round-results") {
          state.lastResult = msg.result;
          state.resultsDismissAt = msg.dismissAt;
          state.activeMinigameId = null;
          state.activeGamemodeId = null;
        } else {
          state.activeMinigameId = null;
          state.activeGamemodeId = null;
          state.lastResult = null;
        }
      } else if (msg.scope === "minigame") {
        // Route by target. Both targets go through the gamemode client; the
        // gamemode client decides whether to forward match-targeted msgs to
        // the active match session (by matchId).
        if (!activeGamemodeSession) return;
        if (msg.target === "gamemode") {
          activeGamemodeSession.onGamemodeMessage(msg);
        } else if (msg.target === "match" && typeof msg.matchId === "string") {
          activeGamemodeSession.onMatchMessage(msg.matchId, msg);
        }
      }
      rerender();
    },
  });

  const interval = setInterval(() => {
    if (state.lobbyState === "preparing") {
      rerender();
    } else if (
      state.lobbyState === "idle" &&
      state.sequence?.autoStartAt &&
      state.sequence.autoStartAt > Date.now()
    ) {
      rerender();
    } else if (
      state.lobbyState === "round-results" &&
      state.resultsDismissAt > Date.now()
    ) {
      rerender();
    } else if (state.gmGraceUntil !== null && state.gmGraceUntil > Date.now()) {
      rerender();
    }
  }, 500);

  return () => {
    clearInterval(interval);
    if (drawerClose) {
      try { drawerClose(); } catch {}
      drawerClose = null;
    }
    teardownGamemode();
    conn.close();
  };
}
