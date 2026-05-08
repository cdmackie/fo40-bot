import { Cron } from "croner";

const _jobs = new Map<string, Cron>();

/**
 * Register (or replace) a cron job.
 * `expr` is a 5-field cron expression. `tz` is an IANA timezone name.
 */
export function addJob(
  id: string,
  expr: string,
  tz: string,
  handler: () => Promise<void> | void,
): Cron {
  const existing = _jobs.get(id);
  if (existing) existing.stop();
  const job = new Cron(expr, { timezone: tz, name: id }, async () => {
    try {
      await handler();
    } catch (err) {
      console.error(`[scheduler] job ${id} threw:`, err);
    }
  });
  _jobs.set(id, job);
  return job;
}

export function removeJob(id: string): void {
  const j = _jobs.get(id);
  if (j) {
    j.stop();
    _jobs.delete(id);
  }
}

export function shutdownScheduler(): void {
  for (const j of _jobs.values()) j.stop();
  _jobs.clear();
}

/**
 * Naive shift of a 5-field cron's minute/hour by `minutesDelta`. Only handles
 * literal numeric minute and hour fields. Returns null if the expression is
 * too complex to shift safely.
 *
 * Handles midnight crossings by adjusting `dow` for single-digit values, and
 * leaves `*` alone.
 */
export function shiftCron(expr: string, minutesDelta: number): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [
    string, string, string, string, string,
  ];
  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h)) return null;

  const rawTotal = h * 60 + m + minutesDelta;
  const dayMinutes = 24 * 60;
  const crossedBack = rawTotal < 0;
  const crossedFwd = rawTotal >= dayMinutes;
  const total = ((rawTotal % dayMinutes) + dayMinutes) % dayMinutes;
  const newH = Math.floor(total / 60);
  const newM = total % 60;

  let newDow = dow;
  if (crossedBack || crossedFwd) {
    if (/^\d+$/.test(dow)) {
      const delta = crossedBack ? -1 : 1;
      newDow = String((parseInt(dow, 10) + delta + 7) % 7);
    } else if (dow === "*") {
      newDow = "*";
    } else {
      return null;
    }
  }

  return `${newM} ${newH} ${dom} ${month} ${newDow}`;
}
