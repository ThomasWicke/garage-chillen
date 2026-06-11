// Warm-up overlay — shown by the gamemode client on top of a freshly
// mounted match scene until the server's `goAt`. The scene behind it is
// live (frozen by the server), so players see exactly what they're about
// to play, read the one-line controls hint, and get a 3-2-1-GO count.
// pointer-events: none — stray taps are harmless (the server ignores
// inputs before goAt anyway).

export function showWarmupOverlay(
  container: HTMLElement,
  goAt: number,
  hint: string | null,
): () => void {
  if (goAt - Date.now() <= 0) return () => {};

  const el = document.createElement("div");
  el.className = "warmup-overlay";
  el.innerHTML = `
    <div class="warmup-num"></div>
    ${hint ? `<div class="warmup-hint">${escapeHtml(hint)}</div>` : ""}
  `;
  container.appendChild(el);
  const numEl = el.querySelector<HTMLElement>(".warmup-num")!;

  let timer: ReturnType<typeof setInterval> | null = null;
  let removeTimeout: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (removeTimeout) clearTimeout(removeTimeout);
    removeTimeout = null;
    el.remove();
  };

  const update = () => {
    const left = goAt - Date.now();
    if (left <= 0) {
      if (timer) clearInterval(timer);
      timer = null;
      numEl.textContent = "GO!";
      el.classList.add("go");
      removeTimeout = setTimeout(cleanup, 600);
      return;
    }
    numEl.textContent = String(Math.ceil(left / 1000));
  };
  update();
  timer = setInterval(update, 100);

  return cleanup;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
