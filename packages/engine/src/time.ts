import type { LogRecord, Millis } from "./types.js";

export const MINUTE_MS = 60_000;
export const HALF_HOUR_MS = 30 * MINUTE_MS;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Dedup TTL and past-retention cutoff (PLAN.md, locked decisions). */
export const RETENTION_MS = 30 * DAY_MS;

export function halfHour(t: Millis): number {
  return Math.floor(t / HALF_HOUR_MS);
}

/** Uses record fields only, so a replay hours later decides the same way. */
export function isPastRetention(rec: Pick<LogRecord, "appendedAt" | "sentAt">): boolean {
  return rec.appendedAt - rec.sentAt > RETENTION_MS;
}
