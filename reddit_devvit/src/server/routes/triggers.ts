import { Hono } from 'hono';
import { reddit, settings } from '@devvit/web/server';
import type { TriggerResponse } from '@devvit/web/shared';
import { alreadyRelayed } from '../core/dedup';
import { withRetry } from '../core/retry';
import { postWebhook } from '../core/webhook';

// Trigger handlers must return within Devvit's 30s HTTP handler timeout, so
// these retry delays plus a small fetch budget stay safely under that
// ceiling (2s + 5s + 15s = 22s of waiting on the worst-case path).
const TRIGGER_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

// The wire payload for onModAction matches the protobuf-JSON ModAction shape:
// { action, actionedAt, subreddit:{name}, moderator:{name}, targetUser:{name}, ... }
type ModActionInput = {
  action?: string;
  actionedAt?: string;
  subreddit?: { name?: string };
  moderator?: { name?: string };
  targetUser?: { name?: string };
};

export const triggers = new Hono();

triggers.post('/mod-action', async (c) => {
  const event = await c.req.json<ModActionInput>();
  const action = event.action;

  if (action !== 'banuser' && action !== 'unbanuser') {
    return c.json<TriggerResponse>({}, 200);
  }

  const webhookUrl = (await settings.get('discord_webhook_url')) as string | undefined;
  if (!webhookUrl) {
    console.warn('[fo40-bridge] discord_webhook_url not configured; skipping');
    return c.json<TriggerResponse>({}, 200);
  }

  const targetUser = event.targetUser?.name;
  if (!targetUser) {
    console.warn(`[fo40-bridge] ${action} event missing targetUser; skipping`);
    return c.json<TriggerResponse>({}, 200);
  }

  // Dedup Reddit's 4-8x duplicate trigger emissions for the same logical
  // action. Skip silently if we've already relayed this event - keeps the
  // bridge channel clean.
  if (await alreadyRelayed(action, targetUser, event.actionedAt)) {
    return c.json<TriggerResponse>({}, 200);
  }

  const moderator = event.moderator?.name ?? '?';

  if (action === 'unbanuser') {
    try {
      await withRetry(
        () =>
          postWebhook(
            webhookUrl,
            '[fo40-bridge] unban',
            [
              { name: 'reddit_username', value: targetUser, inline: true },
              { name: 'moderator', value: moderator, inline: true },
            ],
            0x2ecc71,
          ),
        TRIGGER_RETRY_DELAYS_MS,
        `relay unban u/${targetUser}`,
      );
      console.log(`[fo40-bridge] relayed unban: u/${targetUser}`);
    } catch (err) {
      console.error('[fo40-bridge] failed to relay unban after retries:', err);
    }
    return c.json<TriggerResponse>({}, 200);
  }

  // The ModAction trigger event doesn't include description/details for
  // banuser. Reddit DOES expose them via the modlog REST endpoint
  // (getModerationLog), so we fetch the most recent banuser entry for this
  // target user and pull the reason from there. If the fetch fails or returns
  // nothing (race, missing perms, etc.) we fall back to "(no reason)" so the
  // ban is still mirrored.
  const subredditName = event.subreddit?.name;
  let reason = '(no reason)';
  if (subredditName) {
    try {
      const logListing = reddit.getModerationLog({
        subredditName,
        type: 'banuser',
        limit: 25,
      });
      for await (const entry of logListing) {
        if (entry.target?.author === targetUser) {
          const desc = (entry.description ?? '').trim();
          const det = (entry.details ?? '').trim();
          const combined = [desc, det].filter(Boolean).join(': ');
          if (combined) {
            reason = combined.slice(0, 1024);
          }
          break;
        }
      }
    } catch (err) {
      console.warn('[fo40-bridge] modlog reason fetch failed:', err);
    }
  }

  try {
    await withRetry(
      () =>
        postWebhook(
          webhookUrl,
          '[fo40-bridge] ban',
          [
            { name: 'reddit_username', value: targetUser, inline: true },
            { name: 'moderator', value: moderator, inline: true },
            { name: 'reason', value: reason, inline: false },
          ],
          0xe74c3c,
        ),
      TRIGGER_RETRY_DELAYS_MS,
      `relay ban u/${targetUser}`,
    );
    console.log(`[fo40-bridge] relayed ban: u/${targetUser}`);
  } catch (err) {
    console.error('[fo40-bridge] failed to relay ban after retries:', err);
  }

  return c.json<TriggerResponse>({}, 200);
});
