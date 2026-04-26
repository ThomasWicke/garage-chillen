// Hard install gate — every player is expected to use the app as a PWA.
// In dev or for debugging, an "open in browser anyway" escape hatch is offered.

export function renderInstallGate(onBypass: () => void): void {
  const isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="install-gate">
      <div class="logo">G·<span class="accent">C</span></div>
      <h2>Garage chillen</h2>
      <p>Install to your home screen for the full party-game experience — fullscreen, no browser chrome, no swiping away by accident.</p>
      ${
        isiOS
          ? `
        <div class="step">
          1. Tap the <strong>Share</strong> button at the bottom of Safari<br>
          2. Scroll down and tap <strong>Add to Home Screen</strong><br>
          3. Open Garage chillen from your home screen
        </div>`
          : `
        <div class="step">
          Open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.
        </div>`
      }
      <button class="escape" id="bypass">continue in browser anyway</button>
    </div>
  `;
  document.getElementById("bypass")!.addEventListener("click", onBypass);
}
