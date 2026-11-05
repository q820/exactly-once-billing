/** FNV-1a, 32-bit. Stable across runtimes, so partition assignment is deterministic. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** partition = hash(messageId) % P: every copy of a message lands on one partition. */
export function partitionFor(messageId: string, partitions: number): number {
  return fnv1a32(messageId) % partitions;
}
