import { formatBatchId, HALF_HOUR_MS, type BatchId } from "@eob/engine";

export const usd = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

export const signedUsd = (micros: number) => (micros > 0 ? "+" : micros < 0 ? "−" : "") + usd(Math.abs(micros));

/** UTC, since the sim's timestamps are UTC. */
export function halfHourLabel(halfHour: number): string {
  const iso = new Date(halfHour * HALF_HOUR_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function timeLabel(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const bid = (id: BatchId | null | undefined) => (id ? formatBatchId(id) : "–");

export const days = (ms: number) => `${(ms / 86_400_000).toFixed(1)} days`;
