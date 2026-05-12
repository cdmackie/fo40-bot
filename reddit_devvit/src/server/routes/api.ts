import { Hono } from 'hono';
import { reddit, settings } from '@devvit/web/server';
import type { JoinTokenResponse } from '../../shared/api';
import { signToken } from '../core/signing';

// Token TTL (seconds). Must match the bot's TOKEN_TTL_SECONDS.
const TOKEN_TTL_SECONDS = 10 * 60;

export const api = new Hono();

api.post('/join-token', async (c) => {
  const [secret, botUrl] = await Promise.all([
    settings.get('signing_secret') as Promise<string | undefined>,
    settings.get('bot_join_url') as Promise<string | undefined>,
  ]);

  if (!secret || !botUrl) {
    return c.json<JoinTokenResponse>({ ok: false, reason: 'not_configured' }, 200);
  }

  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<JoinTokenResponse>({ ok: false, reason: 'not_logged_in' }, 200);
  }

  try {
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const token = signToken({ u: username, e: expiresAt }, secret);
    const sep = botUrl.includes('?') ? '&' : '?';
    const url = `${botUrl}${sep}token=${encodeURIComponent(token)}`;
    return c.json<JoinTokenResponse>({ ok: true, url }, 200);
  } catch (err) {
    console.error('[fo40-bridge] failed to issue join URL:', err);
    return c.json<JoinTokenResponse>({ ok: false, reason: 'sign_failed' }, 200);
  }
});
