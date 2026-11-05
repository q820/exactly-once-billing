/** Min-heap on (time, seq): ties run in insertion order, so the schedule is deterministic. */
export class EventQueue<T> {
  private heap: { t: number; seq: number; value: T }[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(t: number, value: T): void {
    const h = this.heap;
    h.push({ t, seq: this.seq++, value });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  pop(): { t: number; value: T } | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(l, m)) m = l;
        if (r < h.length && this.less(r, m)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return { t: top.t, value: top.value };
  }

  private less(i: number, j: number): boolean {
    const a = this.heap[i]!;
    const b = this.heap[j]!;
    return a.t !== b.t ? a.t < b.t : a.seq < b.seq;
  }
}
