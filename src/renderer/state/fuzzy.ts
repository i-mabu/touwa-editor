/** Minimal VS Code-style fuzzy matching: case-insensitive subsequence. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      qi += 1;
      consecutive += 1;
      // Bonus for matches at the start, after a separator, or in a run.
      score +=
        10 +
        consecutive * 5 +
        (i === 0 || t[i - 1] === "/" || t[i - 1] === "-" || t[i - 1] === "_"
          ? 8
          : 0);
    } else {
      consecutive = 0;
      score -= 1;
    }
  }
  if (qi !== q.length) return null;
  // Prefer shorter candidates when scores are close.
  return score - t.length * 0.1;
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  textOf: (item: T) => string,
): T[] {
  const trimmed = query.trim();
  if (trimmed === "") return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(trimmed, textOf(item)) }))
    .filter(
      (entry): entry is { item: T; score: number } => entry.score !== null,
    )
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}
