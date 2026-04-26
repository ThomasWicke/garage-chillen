// Single-elimination bracket scheduler. Mini-game-agnostic — used by the
// lobby to orchestrate 1v1 mini-games (Pong, eventually Asteroids) when the
// lobby has 3+ players.
//
// Algorithm:
//   1. Random shuffle of the player list (random seeding).
//   2. Pad to next power-of-2 with `null` slots (these become byes).
//   3. Round 0 pairs adjacent slots; bye matches auto-advance.
//   4. Subsequent rounds are placeholders that fill as winners propagate.
//   5. After the final, placements() converts to placement (1 = winner).

export type BracketMatch = {
  matchId: string;
  round: number;
  index: number;
  a: string | null;
  b: string | null;
  winner: string | null;
};

export type Bracket = {
  matches: BracketMatch[];
  rounds: number;
  participants: string[]; // original list pre-shuffle; for placement bookkeeping
};

export function buildBracket(playerIds: string[]): Bracket {
  if (playerIds.length < 2) {
    throw new Error("buildBracket requires at least 2 players");
  }
  const shuffled = shuffle([...playerIds]);
  let slots = 1;
  let rounds = 0;
  while (slots < shuffled.length) {
    slots *= 2;
    rounds++;
  }
  const numByes = slots - shuffled.length;
  const numFirstRoundMatches = slots / 2;
  // Place byes so each bye match has exactly one player + one null. Top
  // entries in the shuffled list get byes; the remaining players play each
  // other in regular matches. This guarantees no (null, null) match and no
  // round-1 slot that's null because of double-bye chains.
  const padded: (string | null)[] = [];
  let playerIdx = 0;
  for (let i = 0; i < numFirstRoundMatches; i++) {
    if (i < numByes) {
      padded.push(shuffled[playerIdx++]);
      padded.push(null);
    } else {
      padded.push(shuffled[playerIdx++]);
      padded.push(shuffled[playerIdx++]);
    }
  }

  const matches: BracketMatch[] = [];
  for (let i = 0; i < numFirstRoundMatches; i++) {
    matches.push({
      matchId: `r0m${i}`,
      round: 0,
      index: i,
      a: padded[i * 2],
      b: padded[i * 2 + 1],
      winner: null,
    });
  }
  for (let r = 1; r < rounds; r++) {
    const count = slots / Math.pow(2, r + 1);
    for (let i = 0; i < count; i++) {
      matches.push({
        matchId: `r${r}m${i}`,
        round: r,
        index: i,
        a: null,
        b: null,
        winner: null,
      });
    }
  }

  const bracket: Bracket = { matches, rounds, participants: [...playerIds] };

  // Auto-advance round-0 byes (one slot filled, the other null). Do NOT
  // cascade to higher rounds: a null slot in round 1+ means "waiting for
  // a child match's winner", not "no opponent".
  for (const m of matches.filter((m) => m.round === 0)) {
    if (m.a && !m.b) recordMatchResult(bracket, m.matchId, m.a);
    else if (m.b && !m.a) recordMatchResult(bracket, m.matchId, m.b);
  }

  return bracket;
}

export function nextMatch(bracket: Bracket): BracketMatch | null {
  return (
    bracket.matches.find(
      (m) => m.winner === null && m.a !== null && m.b !== null,
    ) ?? null
  );
}

export function recordMatchResult(
  bracket: Bracket,
  matchId: string,
  winner: string,
): void {
  const m = bracket.matches.find((x) => x.matchId === matchId);
  if (!m) throw new Error(`Match ${matchId} not found`);
  if (m.winner !== null) return; // idempotent
  m.winner = winner;
  // Propagate to the parent slot in the next round, if any.
  if (m.round + 1 < bracket.rounds) {
    const parentIdx = Math.floor(m.index / 2);
    const parent = bracket.matches.find(
      (p) => p.round === m.round + 1 && p.index === parentIdx,
    );
    if (parent) {
      if (m.index % 2 === 0) parent.a = winner;
      else parent.b = winner;
    }
  }
}

export function isComplete(bracket: Bracket): boolean {
  if (bracket.matches.length === 0) return false;
  const final = bracket.matches[bracket.matches.length - 1];
  return final.winner !== null;
}

/**
 * Final placements: 1 = winner, 2 = runner-up, ties for further-back rounds.
 * Loser of round R gets placement = 2^(rounds-1-R) + 1.
 *   • final (R=rounds-1): 2nd
 *   • semis (R=rounds-2): 3rd (tied)
 *   • quarters (R=rounds-3): 5th (tied)
 *   • etc.
 */
export function placements(bracket: Bracket): Record<string, number> {
  const result: Record<string, number> = {};
  for (const m of bracket.matches) {
    if (m.winner === null) continue;
    const loser = m.a === m.winner ? m.b : m.a;
    if (loser === null) continue;
    const placement = Math.pow(2, bracket.rounds - 1 - m.round) + 1;
    // Don't overwrite a better placement (winner of an earlier round).
    if (result[loser] === undefined || placement < result[loser]) {
      result[loser] = placement;
    }
  }
  // Champion.
  const final = bracket.matches[bracket.matches.length - 1];
  if (final?.winner) result[final.winner] = 1;
  // Anyone never placed (shouldn't happen, but guards against bugs):
  for (const pid of bracket.participants) {
    if (result[pid] === undefined) result[pid] = bracket.participants.length;
  }
  return result;
}

/**
 * Convert placements to session points. Curated curve favors top finishers
 * but still rewards making it past round 1.
 */
export function placementsToPoints(
  placement: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pid, p] of Object.entries(placement)) {
    out[pid] = pointsForPlacement(p);
  }
  return out;
}

function pointsForPlacement(placement: number): number {
  if (placement === 1) return 10;
  if (placement === 2) return 5;
  if (placement === 3) return 3; // semi-finalists tie
  if (placement <= 5) return 1; // quarter-finalists tie
  return 0;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
