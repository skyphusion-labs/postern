// Semantic ranking over hydrated, already-scoped candidates (#813). PURE: no imports, so
// the offline recall eval (inbound/eval/) runs exactly this code.
//
// The problem it fixes: templated notifications ("Run failed: corpus-sync") embed almost
// identically. The tokens that tell one from another (a commit hash, an order number, a
// run id) carry little weight in an embedding. So a known-item query came back with an
// older near-twin, and a family of twenty could fill the whole top ten.
//
// INPUT IS SCOPED: callers pass only candidates the reader may see (after the access,
// viewer and #853 guard filters). Every count and id this returns is therefore about
// visible mail only. A count that included a hidden member would disclose that it exists.

/** A family of near-identical mail: the sender plus the subject with the variable parts
 *  masked (hex runs of 7 or more, `#`-ids and digit runs), lower-cased, reply/forward
 *  prefixes dropped. "Run failed: corpus-sync #4821" and "#4822" share a key. */
export function templateKey(from: string, subject: string): string {
  const sender = (from ?? "").toLowerCase().replace(/^.*</, "").replace(/>.*$/, "").trim();
  const subj = (subject ?? "")
    .toLowerCase()
    .replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/, "")
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/#?\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${sender}|${subj}`;
}

/** The query's distinct tokens: letters and digits, 3 or more characters, lower-cased. */
export function queryTokens(q: string): string[] {
  return [...new Set((q ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
}

/** How many of `tokens` occur as whole tokens in `text`. */
export function overlap(tokens: readonly string[], text: string): number {
  if (tokens.length === 0) return 0;
  const have = new Set((text ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  let n = 0;
  for (const t of tokens) if (have.has(t)) n++;
  return n;
}

export interface RankInput {
  id: string;
  key: string; // templateKey
  score: number; // cosine
  date: string; // ISO, for the newest-first tiebreak
}

export interface RankOutput {
  id: string;
  /** Set on a family's representative when collapsing: its OTHER visible members,
   *  best score first (ids capped, count exact). */
  similar?: { count: number; ids: string[] };
}

/** Cosine scores this close to the family's best count as a tie. */
export const NEAR_TIE = 0.03;
export const SIMILAR_IDS_CAP = 20;

/**
 * Reorder near-ties inside each template family, and optionally collapse each family to
 * one representative.
 *
 * `items` arrive best score first. Within a family, members scoring within NEAR_TIE of the
 * family's best are reordered by lexical overlap with the query (more first), then newest
 * first, then score. They keep the SLOTS they held, so no other family moves. Members
 * outside the tie window, and every family of one, are untouched.
 *
 * With `collapse`, each family keeps only its tiebreak winner, at the family's first slot,
 * carrying `similar` = every other member. `lexical(id)` is the text the query tokens are
 * matched against (subject and body); it is called only for members of a family of two or
 * more that tie.
 */
export function rankFamilies(
  items: readonly RankInput[],
  tokens: readonly string[],
  lexical: (id: string) => string,
  opts: { collapse: boolean },
): RankOutput[] {
  const families = new Map<string, number[]>(); // key -> indexes into items, in order
  items.forEach((it, i) => {
    const list = families.get(it.key);
    if (list) list.push(i);
    else families.set(it.key, [i]);
  });
  const order = items.map((_, i) => i); // slot -> item index
  const winnerOf = new Map<string, number>();
  for (const [key, members] of families) {
    if (members.length < 2) {
      winnerOf.set(key, members[0]);
      continue;
    }
    const best = items[members[0]].score;
    const tied = members.filter((i) => items[i].score >= best - NEAR_TIE);
    if (tied.length > 1) {
      const lex = new Map(tied.map((i) => [i, overlap(tokens, lexical(items[i].id))]));
      const sorted = [...tied].sort(
        (a, b) =>
          (lex.get(b) as number) - (lex.get(a) as number) ||
          (items[b].date > items[a].date ? 1 : items[b].date < items[a].date ? -1 : 0) ||
          items[b].score - items[a].score,
      );
      // The tied members keep their slots; only who sits in them changes.
      tied.forEach((slot, k) => {
        order[slot] = sorted[k];
      });
      winnerOf.set(key, sorted[0]);
    } else {
      winnerOf.set(key, members[0]);
    }
  }
  if (!opts.collapse) return order.map((i) => ({ id: items[i].id }));
  const out: RankOutput[] = [];
  const emitted = new Set<string>();
  for (const i of order) {
    const key = items[i].key;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const winner = winnerOf.get(key) as number;
    const others = (families.get(key) as number[]).filter((m) => m !== winner).map((m) => items[m].id);
    out.push(others.length ? { id: items[winner].id, similar: { count: others.length, ids: others.slice(0, SIMILAR_IDS_CAP) } } : { id: items[winner].id });
  }
  return out;
}

/**
 * #926: fold hits that share a thread into the thread's FIRST (best-ranked) hit, which
 * carries `threadHits` = the thread's other hits, in order (ids capped, count exact).
 * Runs after `rankFamilies`, over the hits that are still top-level: a message already
 * folded into a family's `similar` is not counted again. Input is scoped (see the head of
 * this file), so the counts cover visible mail only.
 */
export function foldThreads(
  items: readonly { id: string; thread: string }[],
): Array<{ id: string; threadHits?: { count: number; ids: string[] } }> {
  const firstOf = new Map<string, number>();
  const others = new Map<string, string[]>();
  items.forEach((it, i) => {
    if (!firstOf.has(it.thread)) firstOf.set(it.thread, i);
    else (others.get(it.thread) ?? others.set(it.thread, []).get(it.thread)!).push(it.id);
  });
  const out: Array<{ id: string; threadHits?: { count: number; ids: string[] } }> = [];
  items.forEach((it, i) => {
    if (firstOf.get(it.thread) !== i) return;
    const rest = others.get(it.thread);
    out.push(rest ? { id: it.id, threadHits: { count: rest.length, ids: rest.slice(0, SIMILAR_IDS_CAP) } } : { id: it.id });
  });
  return out;
}
