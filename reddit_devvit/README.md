# fo40-bridge — Devvit app

Companion Devvit app for the [FriendsOver40 Discord bot](../README.md). Relays r/FriendsOver40 modlog bans and Discord-link verifications to a Discord webhook so the linked Discord server can mirror moderator decisions.

This app is **not intended for the public App Directory** — it's a single-purpose tool for one specific subreddit (r/FriendsOver40) and its companion Discord server.

See [`PRIVACY.md`](PRIVACY.md) and [`TERMS.md`](TERMS.md) for the data-handling details required by Reddit's App Review for any app that uses HTTP fetch.

## What it does

1. **Modlog ban relay.** Listens to the subreddit's `ModAction` events. When a moderator bans a user, posts a structured embed (containing the banned user's Reddit username, the moderator's name, and the reason) to a Discord webhook URL configured in app settings. The companion Discord bot reads that embed from a private channel and applies a Discord ban to the linked Discord account, if any. One-way only — Discord-side actions are not propagated back to Reddit.
2. **Discord-link verification.** Adds a "Link Discord account" subreddit menu item. A logged-in Reddit user opens it, pastes a 6-digit one-time code they got from Discord's `/link-reddit` command, and the app posts a `verify` embed (containing only the user's Reddit username and the code) to the same webhook. The Discord bot matches the code to the originating Discord user and writes the link.

The Discord bot holds no Reddit credentials and makes no Reddit API calls. All Reddit-side logic lives in this app.

## HTTP fetch domains

This app only posts to **`discord.com`**, which is on Devvit's global fetch allowlist. Specifically, it POSTs JSON-encoded embeds to a Discord webhook URL stored in the app's `discord_webhook_url` setting (configured per-install by a subreddit moderator). Nothing is sent anywhere else; no other domain is contacted.

The data sent is limited to:
- For ban events: the banned redditor's username, the modlog event's moderator and reason — all data already visible to mods of the subreddit.
- For verify events: the calling redditor's username and the 6-digit code they entered.

No PII beyond what's already in Reddit's public/mod-visible data is transmitted.

## Setup

Prerequisites:
- Node.js 20+
- A Reddit account that moderates r/FriendsOver40
- The Discord bot is running with a bridge channel + webhook configured (see main repo README)

```bash
# In this directory:
npm install
npx devvit login          # log in as the developer account
npx devvit publish        # submits a build for Reddit App Review (unlisted)
```

`devvit publish` (without `--public`) submits to review but keeps the app unlisted — it will not appear in the App Directory and only the developer can install it. Review typically takes 1-2 business days; you'll get an email when approved.

Once approved:

```bash
npx devvit install r/FriendsOver40
```

Then **on Reddit**, go to `https://www.reddit.com/r/FriendsOver40/about/edit/community-app-settings` (or: subreddit mod tools → "Community apps" → fo40-bridge → settings) and paste the Discord webhook URL into the `discord_webhook_url` field.

The setting is **installation-scoped**, so each subreddit that installs the app configures its own webhook URL independently. This lets the same app serve multiple sister subreddits (e.g. r/FriendsOver40 and r/FriendsOver50) — each with its own companion Discord server and webhook — without sharing credentials.

### Why publish (not upload)?

`npx devvit upload` creates a private build that the developer can install only on subreddits with **fewer than 200 subscribers** (or specific test subs). r/FriendsOver40 is larger, so review is required even though we keep the app unlisted.

### Iterating before publish

To test the trigger and form against a sandbox first, create a tiny private subreddit you mod (e.g. `r/fo40_test`) and run:

```bash
npx devvit playtest fo40_test
```

Hot-reloads on every save. Test a ban (ban a throwaway account in the sandbox sub) to confirm the webhook embed shape lands correctly in your Discord bridge channel.

## Discord-side setup (do this first)

1. In your Discord server, create a channel `#reddit-bridge` (mods/admins only — do not give `40+` view access).
2. Channel Settings → Integrations → Webhooks → New Webhook → name it `fo40-bridge` → copy the webhook URL → save.
3. Note the **webhook ID** (the long number in the URL between `/webhooks/` and `/`). Put it in the bot's `.env` as `BRIDGE_WEBHOOK_ID`.
4. Right-click the bridge channel → Copy Channel ID → put in `.env` as `BRIDGE_CHANNEL_ID`.
5. Restart the bot. Look for a startup line confirming the cog loaded (or the disabled message if either ID is missing).
6. Paste the webhook URL into the Devvit app's `discord_webhook_url` setting.

## Embed protocol

The Discord bot expects exactly two embed shapes from this app's webhook posts (in the bridge channel only):

**Ban event:**
```
title:  "[fo40-bridge] ban"
fields:
  reddit_username: <str>
  moderator:       <str>
  reason:          <str>
```

**Verify event:**
```
title:  "[fo40-bridge] verify"
fields:
  reddit_username: <str>
  code:            <str>
```

Anything else is ignored. The bot also filters by `webhook_id` so other webhooks posting in the same channel won't trigger anything.

## Development

```bash
npx devvit playtest <a test subreddit you mod>    # iterate against a private sub
```

Logs from `console.log` show up in Reddit's developer dashboard at `https://developers.reddit.com/apps/fo40-bridge`.

## Known limitations

- A Discord webhook URL leak means anyone could spoof ban/verify events. The bridge channel must be locked down to mods/admins only — assume the URL is sensitive even though it's "secret-by-obscurity".
- `console.log` debug payloads must not include the webhook URL.
- Verification codes are validated bot-side; an attacker who knows someone's code could complete the link as themselves. Codes are 6 digits → 1-in-a-million guess. With a 10-min TTL and one pending code per Discord user, brute-force is not realistic, but it's not bulletproof either.
- If the Devvit app is uninstalled, ban relaying stops silently — the Discord bot has no way to know. Plan to monitor whether the app is still installed.

## License

BSD-3-Clause (matches the parent repo).
