// Shared match-clock formatting. Servers broadcast `deadlineAt` in every
// state message; games show the remaining time in their status line so
// "time's up · leader wins" never arrives with zero warning.

/** "2:07" style countdown to a server timestamp; "0:00" once passed. */
export function formatRemaining(deadlineAt: number): string {
  const remaining = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Join non-empty status parts with a separator dot. */
export function statusLine(...parts: (string | null | undefined)[]): string {
  return parts.filter((p) => !!p && p.length > 0).join(" · ");
}
