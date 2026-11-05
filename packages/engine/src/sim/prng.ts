import { fnv1a32 } from "../hash.js";

/** Seeded PRNG. The only source of randomness in the engine. */
export interface Prng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

/**
 * Independent streams per concern, so e.g. turning crashes on doesn't change the
 * workload a seed generates.
 */
export function deriveSeed(seed: number, stream: string): number {
  return fnv1a32(`${seed >>> 0}/${stream}`);
}
