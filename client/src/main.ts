// Entry point: install gate → start screen → lobby route. SPA navigation via
// history.pushState; the only URL pattern is /lobby/CODE.

import { renderInstallGate } from "./routes/install-gate";
import { renderStart } from "./routes/start";
import { renderLobby } from "./routes/lobby";

const BYPASS_KEY = "gc.bypass-install";

function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches ||
    localStorage.getItem(BYPASS_KEY) === "1"
  );
}

let cleanupCurrentRoute: (() => void) | null = null;

function navigate(path: string): void {
  if (window.location.pathname !== path) {
    history.pushState(null, "", path);
  }
  route();
}

function route(): void {
  if (cleanupCurrentRoute) {
    cleanupCurrentRoute();
    cleanupCurrentRoute = null;
  }

  const lobbyMatch = window.location.pathname.match(/^\/lobby\/([A-Za-z0-9]+)\/?$/);
  if (lobbyMatch) {
    document.body.classList.add("in-room");
    cleanupCurrentRoute = renderLobby(lobbyMatch[1]);
    return;
  }

  document.body.classList.remove("in-room");
  if (!isStandalone()) {
    renderInstallGate(() => {
      localStorage.setItem(BYPASS_KEY, "1");
      route();
    });
    return;
  }

  renderStart(navigate);
}

window.addEventListener("popstate", route);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

route();
