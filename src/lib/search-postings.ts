/** Release-local substring index. Inputs are already normalized by the caller. */
export class SearchPostings {
  private readonly postings = new Map<string, Set<number>>();

  constructor(private readonly texts: string[]) {
    texts.forEach((text, id) => {
      // Code units deliberately match String.includes, including supplementary characters.
      const grams = new Set<string>();
      for (let i = 0; i < text.length; i += 1) {
        for (let size = 1; size <= 3 && i + size <= text.length; size += 1) grams.add(text.slice(i, i + size));
      }
      for (const gram of grams) {
        let ids = this.postings.get(gram);
        if (!ids) this.postings.set(gram, ids = new Set());
        ids.add(id);
      }
    });
  }

  /** Exact substring hits: grams select candidates; verification rejects out-of-order/repeated grams. */
  find(term: string): Set<number> {
    if (!term) return new Set(this.texts.map((_, id) => id));
    const size = Math.min(3, term.length);
    const lists: Set<number>[] = [];
    for (let i = 0; i + size <= term.length; i += 1) {
      const ids = this.postings.get(term.slice(i, i + size));
      if (!ids) return new Set();
      lists.push(ids);
    }
    lists.sort((a, b) => a.size - b.size);
    return new Set([...lists[0]].filter((id) => lists.every((ids) => ids.has(id)) && this.texts[id].includes(term)));
  }

  any(terms: string[]): Set<number> {
    const ids = new Set<number>();
    for (const term of terms) for (const id of this.find(term)) ids.add(id);
    return ids;
  }
}
