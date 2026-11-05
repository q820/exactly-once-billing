import type { BatchId } from "./types.js";

/**
 * Lexicographic (epoch, idx). idx increases across epochs, so for batches planned
 * by a correct worker this agrees with idx order. A replay keeps its original id;
 * re-stamping it with the new epoch would make it compare greater than its own
 * first attempt.
 */
export function compareBatchId(a: BatchId, b: BatchId): number {
  return a.epoch !== b.epoch ? a.epoch - b.epoch : a.idx - b.idx;
}

export function batchIdEquals(a: BatchId, b: BatchId): boolean {
  return a.epoch === b.epoch && a.idx === b.idx;
}

export function formatBatchId(id: BatchId): string {
  return `(${id.epoch},${id.idx})`;
}
