# fo40-bridge — Devvit app

Companion Devvit app for the [FriendsOver40 Discord bot](../README.md). Two integrations:

1. **Modlog ban relay.** When a mod bans a user on r/FriendsOver40, the app posts a structured embed to a Discord webhook. The bot reads it and bans the linked Discord user.
2. **Invite-link join flow.** A pinned custom post on r/FriendsOver40 has a "Get Discord invite" button. When a Reddit user clicks it, the app signs an HMAC token containing their Reddit username and redirects them to the bot's web server, which creates a one-time-use Discord invite and sends the user to discord.gg. On member join, the bot auto-links the Discord account to the Reddit username and assigns the `40+` role.

This app is **not intended for the public App Directory** — it's a private tool for r/FriendsOver40 (and any sister subs we install it on, e.g. r/FriendsOver50).

See [`PRIVACY.md`](PRIVACY.md) and [`TERMS.md`](TERMS.md) for the data-handling details required by Reddit's App Review.

## User experience

For a Reddit user joining the Discord:
1. They click "Get Discord invite" on the pinned post on r/FriendsOver40.
2. Their browser is redirected through the bot's server to a single-use Discord invite link.
3. They click "Accept Invite" in Discord.
4. They land in the server with the `40+` role already applied and a welcome DM.

**No slash commands. No codes. No forms.** Two clicks total.

## HTTP fetch domains

This app only POSTs to `discord.com`, which is on Devvit's global fetch allowlist. JSON-encoded ban event embeds go to a Discord webhook URL stored in the install setting `discord_webhook_url`.

The invite-link button does NOT use HTTP fetch — it navigates the user's browser to the Discord bot's public URL via `context.ui.navigateTo()`, which doesn't count as a fetch. (The token is signed in-app with HMAC-SHA256.)

Data sent:
- Ban events: banned redditor's username, modlog moderator, ban reason — all already mod-visible on Reddit.
- Invite-link tokens (in URL query string): the user's Reddit username and an expiry timestamp, HMAC-signed with the shared secret.

No PII beyond what's already on Reddit is transmitted.

## Setup

Prerequisites:
- Node.js 20+
- A Reddit account that moderates r/FriendsOver40
- The Discord bot is running with a public URL, a bridge channel + webhook, and a 32+ char `BRIDGE_SIGNING_SECRET` in its `.env` (see the main repo README)

```bash
# In this directory:
npm install
npx devvit login
npx devvit publish        # submits to App Review (unlisted)
```

Review typically takes 1-2 business days for first launches, often faster for updates. Once approved:

```bash
npx devvit install r/FriendsOver40
```

Then on Reddit, go to `https://www.reddit.com/r/FriendsOver40/about/edit/community-app-settings` (or: subreddit mod tools → "Community apps" → fo40-bridge → settings) and fill in:

| Setting | Value |
| --- | --- |
| `discord_webhook_url` | The Discord webhook URL from your bridge channel |
| `signing_secret` | Same value as the bot's `BRIDGE_SIGNING_SECRET` (32+ chars random) |
| `bot_join_url` | The bot's public `/join` URL, e.g. `https://fo40.example.com/join` |

All settings are **installation-scoped**, so each subreddit (e.g. r/FriendsOver40 and r/FriendsOver50) configures its own.

## Creating the pinned join post

After installing the app, run the **"Create Discord-join post (mods only)"** menu item from the subreddit overflow menu. This creates a custom post titled "Join the FriendsOver40 Discord". Pin it to your subreddit so it's the first thing visitors see.

## Iterating before publish

To test against a sandbox without going through review (only works on subs <200 subscribers):

```bash
npx devvit playtest <your-test-subreddit>
```

Hot-reloads on every save. Test the flow by clicking the join button and watching for the redirect chain to land you in your test Discord server.

## Embed protocol (ban relay)

The bot expects exactly this embed shape from this app's webhook posts:

```
title:  "[fo40-bridge] ban"
fields:
  reddit_username: <str>
  moderator:       <str>
  reason:          <str>
```

Anything else is ignored. The bot also filters by `webhook_id` so other webhooks posting in the same channel won't trigger anything.

## Token format (invite-link flow)

```
<base64url(payload_json)>.<base64url(hmac_sha256(payload_json, signing_secret))>
```

Payload JSON:
```json
{ "u": "<reddit_username>", "e": <unix_epoch_seconds_when_token_expires> }
```

The bot's `web/server.py` validates both the signature and the expiry before issuing an invite.

## Known limitations

- **Webhook URL leak** = anyone can spoof ban events. Lock the bridge channel down to mods/admins only.
- **Signing secret leak** = anyone can forge invite-link URLs and claim any Reddit username for any Discord account. Treat it as a credential.
- **Devvit app uninstall is silent** to the bot. If join-button clicks stop working, check the app at `https://developers.reddit.com/apps/fo40-bridge`.
- **Custom post button on mobile** has been mostly tested via playtest. Behavior on the official Reddit mobile app is generally OK; if a user reports the button doesn't work, fall back to `/link-reddit` mod-driven manual link.

## License

BSD-3-Clause (matches the parent repo).
