// Full-scene visual cue for score events (goal / ring-out / point). Purely
// visual — no sound. Mounted as a DOM overlay above the game canvas so the
// kaplay scenes don't need to know about it.

export type MatchFlash = {
  /** Show `text` big and bright for ~700ms. */
  flash: (text: string) => void;
  destroy: () => void;
};

export function createMatchFlash(host: HTMLElement): MatchFlash {
  const el = document.createElement("div");
  el.className = "match-flash";
  host.appendChild(el);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    flash(text: string) {
      el.textContent = text;
      el.classList.add("show");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        el.classList.remove("show");
        timer = null;
      }, 700);
    },
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        host.removeChild(el);
      } catch {
        /* already gone */
      }
    },
  };
}
