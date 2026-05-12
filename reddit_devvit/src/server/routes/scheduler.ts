import { Hono } from 'hono';
import {
  context,
  reddit,
  settings,
  type TaskResponse,
} from '@devvit/web/server';
import { postWebhookBatch, type WebhookEmbed } from '../core/webhook';

export const schedulerRoutes = new Hono();

// Max embeds per Discord webhook POST. Discord accepts up to 10. Batching
// here is the main throttle defense - Reddit's outbound HTTP gateway rejects
// burst traffic ("HTTP request to discord.com is not allowed due to too many
// requests"), so cutting call volume 10x is the biggest single win.
const EMBEDS_PER_CALL = 10;

// Sleep between batch calls. Combined with batching, ~30 banned users/sec
// throughput - well under any reasonable rate limit, and a 1000-user list
// finishes in ~100s.
const BATCH_DELAY_MS = 1000;

function buildBanEmbed(redditUsername: string): WebhookEmbed {
  return {
    title: '[fo40-bridge] ban',
    color: 0xe74c3c,
    fields: [
      { name: 'reddit_username', value: redditUsername, inline: true },
      { name: 'moderator', value: '(bulk sync)', inline: true },
      {
        name: 'reason',
        value: '(bulk sync from banned-users list)',
        inline: false,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

schedulerRoutes.post('/sync-banned', async (c) => {
  const { subredditName } = context;
  const webhookUrl = (await settings.get('discord_webhook_url')) as
    | string
    | undefined;

  if (!webhookUrl) {
    console.error(
      '[fo40-bridge] sync-banned task: discord_webhook_url not configured; aborting',
    );
    return c.json<TaskResponse>({});
  }
  if (!subredditName) {
    console.error(
      '[fo40-bridge] sync-banned task: no subreddit in context; aborting',
    );
    return c.json<TaskResponse>({});
  }

  console.log(
    `[fo40-bridge] sync-banned task starting for r/${subredditName}`,
  );

  let sent = 0;
  let errors = 0;
  let buffer: WebhookEmbed[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const count = buffer.length;
    try {
      await postWebhookBatch(webhookUrl, buffer);
      sent += count;
    } catch (err) {
      errors += count;
      console.error(
        `[fo40-bridge] sync-banned task: batch of ${count} failed:`,
        err,
      );
    }
    buffer = [];
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  };

  try {
    const bannedListing = reddit.getBannedUsers({
      subredditName,
      limit: 1000,
    });
    for await (const banned of bannedListing) {
      buffer.push(buildBanEmbed(banned.username));
      if (buffer.length >= EMBEDS_PER_CALL) {
        await flush();
      }
    }
    await flush();
  } catch (err) {
    console.error(
      '[fo40-bridge] sync-banned task: failed listing banned users:',
      err,
    );
  }

  console.log(
    `[fo40-bridge] sync-banned task complete: ${sent} bans relayed, ${errors} errors`,
  );
  return c.json<TaskResponse>({});
});
