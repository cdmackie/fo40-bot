import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, EntrypointHeight, reddit, settings } from '@devvit/web/server';
import { postWebhook } from '../core/webhook';

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || 'Error with no message';
  }
  if (err === undefined) return 'threw undefined';
  if (err === null) return 'threw null';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

export const menu = new Hono();

menu.post('/create-post', async (c) => {
  const { subredditName } = context;
  if (!subredditName) {
    return c.json<UiResponse>({
      showToast:
        "Couldn't determine current subreddit. Try clicking the menu from the subreddit page directly.",
    });
  }

  try {
    const post = await reddit.submitCustomPost({
      title: 'Join the FriendsOver40 Discord',
    });

    // Passing `styles` to submitCustomPost currently triggers a platform bug
    // (empty gRPC status) - see reddit/devvit#258. Workaround: set height
    // after creation. The entrypoint's `height: "regular"` in devvit.json
    // alone is not honored; the per-post style is what Reddit actually uses.
    try {
      await post.setCustomPostStyles({ height: EntrypointHeight.REGULAR });
    } catch (styleErr) {
      console.warn('[fo40-bridge] failed to set post height; post created but stays default:', styleErr);
    }

    return c.json<UiResponse>({
      navigateTo: `https://reddit.com/r/${subredditName}/comments/${post.id.replace(/^t3_/, '')}`,
      showToast: `Created post in r/${subredditName}. Pin it to your subreddit.`,
    });
  } catch (err) {
    console.error('[fo40-bridge] failed to create join post:', err);
    console.error('[fo40-bridge] error details:', JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));
    return c.json<UiResponse>({
      showToast: `Failed to create post: ${describeError(err).slice(0, 200)}`,
    });
  }
});

menu.post('/sync-banned', async (c) => {
  const webhookUrl = (await settings.get('discord_webhook_url')) as string | undefined;
  if (!webhookUrl) {
    return c.json<UiResponse>({
      showToast:
        'discord_webhook_url not configured. Set it in app install settings first.',
    });
  }

  const { subredditName } = context;
  if (!subredditName) {
    return c.json<UiResponse>({
      showToast:
        "Couldn't determine current subreddit. Try clicking the menu from the subreddit page directly.",
    });
  }

  let sent = 0;
  let errors = 0;
  try {
    const bannedListing = reddit.getBannedUsers({ subredditName, limit: 1000 });
    for await (const banned of bannedListing) {
      try {
        await postWebhook(
          webhookUrl,
          '[fo40-bridge] ban',
          [
            { name: 'reddit_username', value: banned.username, inline: true },
            { name: 'moderator', value: '(bulk sync)', inline: true },
            {
              name: 'reason',
              value: '(bulk sync from banned-users list)',
              inline: false,
            },
          ],
          0xe74c3c,
        );
        sent += 1;
      } catch (err) {
        console.error(
          `[fo40-bridge] sync: failed to relay ban for u/${banned.username}:`,
          err,
        );
        errors += 1;
      }
    }
  } catch (err) {
    console.error('[fo40-bridge] sync: failed to list banned users:', err);
    return c.json<UiResponse>({
      showToast: `Couldn't list banned users: ${describeError(err).slice(0, 200)}`,
    });
  }

  console.log(`[fo40-bridge] bulk sync: ${sent} sent, ${errors} errors`);
  return c.json<UiResponse>({
    showToast: `Bulk sync done: ${sent} ban events sent (${errors} errors).`,
  });
});
