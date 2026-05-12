import { redis } from '@devvit/web/server';

// How long to remember "we already relayed this event" for trigger-burst dedup.
// Reddit emits the same modaction 4-8x within a few seconds; we only want to
// relay it once. 10 minutes is well above the burst window while still letting
// the dedup keys expire so Redis doesn't grow.
const DEDUP_TTL_SECONDS = 10 * 60;
const HASH_KEY = 'bridge-dedup';

/**
 * Returns true if this exact modaction event has already been relayed (and we
 * should skip), false if this is the first sighting.
 *
 * Uses {action, targetUser, actionedAt} as the dedup key - Reddit's burst
 * emissions all share the same actionedAt timestamp, so they hash to the same
 * key.
 */
export async function alreadyRelayed(
  action: string,
  username: string,
  actionedAt: unknown,
): Promise<boolean> {
  const ts =
    actionedAt instanceof Date
      ? actionedAt.toISOString()
      : typeof actionedAt === 'string'
        ? actionedAt
        : '';
  if (!ts) return false; // no timestamp - can't dedup; better to relay than drop
  const fieldName = `${action}:${username}:${ts}`;
  try {
    // hSetNX is atomic: returns true if the field was newly set, false if it
    // already existed. This wins the race when multiple duplicate emissions
    // hit the dedup at the same instant - only one returns "newly set", the
    // others return "already exists" and skip.
    const wasNew = await redis.hSetNX(HASH_KEY, fieldName, '1');
    if (!wasNew) return true; // someone else already relayed this event
    await redis.expire(HASH_KEY, DEDUP_TTL_SECONDS);
  } catch (err) {
    console.warn('[fo40-bridge] redis dedup failed; relaying anyway:', err);
  }
  return false;
}
