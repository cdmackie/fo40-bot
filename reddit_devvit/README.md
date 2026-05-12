# fo40-bridge - Devvit Web app

Companion [Devvit Web](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview) app for the [FriendsOver40 Discord bot](../README.md). Built on the modern Devvit Web stack (`devvit.json` + Node/Hono server + HTML/TS webview); the legacy Blocks-based `Devvit.addCustomPostType` is deprecated by Reddit and rejected at App Review as of March 2026. Two integrations:

1. **Modlog ban relay.** When a mod bans a user on r/FriendsOver40, the app posts a structured embed to a Discord webhook. The bot reads it and bans the linked Discord user.
2. **Invite-link join flow.** A pinned custom post on r/FriendsOver40 has a "Get Discord invite" button. When a Reddit user clicks it, the app signs an HMAC token containing their Reddit username and redirects them to the bot's web server, which creates a one-time-use Discord invite and sends the user to discord.gg. On member join, the bot auto-links the Discord account to the Reddit username and assigns the `40+` role.

This app is **not intended for the public App Directory** - it's a private tool for r/FriendsOver40 (and any sister subs we install it on, e.g. r/FriendsOver50).

See [`PRIVACY.md`](PRIVACY.md) and [`TERMS.md`](TERMS.md) for the data-handling details required by Reddit's App Review.

## User experience

For a Reddit user joining the Discord:
1. They click "Get Discord invite" on the pinned post on r/FriendsOver40.
2. Their browser is redirected through the bot's server to a single-use Discord invite link.
3. They click "Accept Invite" in Discord.
4. They land in the server with the `40+` role already applied and a welcome DM.

**No slash commands. No codes. No forms.** Two clicks total.

## Network traffic

External outbound traffic from the Devvit sandbox only goes to `discord.com` (declared in `devvit.json` under `permissions.http.domains`). JSON-encoded ban event embeds are POSTed to a Discord webhook URL stored in the install setting `discord_webhook_url`.

The invite-link flow has two hops:
1. The webview (running inside Reddit's iframe) fetches `/api/join-token` from this app's own Devvit server - same-origin, not subject to the external fetch allowlist.
2. The Devvit server reads the current Reddit user via `reddit.getCurrentUsername()`, HMAC-signs a token, and returns a `bot_join_url?token=...` URL. The webview then calls `navigateTo()` (from `@devvit/web/client`) to send the user's browser there - browser navigation isn't a server-side fetch, so the bot's domain doesn't need allowlisting.

Data sent off-platform:
- Ban events: banned redditor's username, modlog moderator, ban reason - all already mod-visible on Reddit.
- Invite-link tokens (in the URL the user navigates to): the user's Reddit username and an expiry timestamp, HMAC-signed with the shared secret.

No PII beyond what's already on Reddit is transmitted.

## Setup

Prerequisites:
- Node.js 22+ (Devvit Web requires `>=22.2.0`)
- A Reddit account that moderates r/FriendsOver40
- The Discord bot is running with a public URL, a bridge channel + webhook, and a 32+ char `BRIDGE_SIGNING_SECRET` in its `.env` (see the main repo README)

```bash
# In this directory:
npm install
npm run build             # vite build -> dist/{client,server}
npx devvit login
npx devvit upload         # uploads the build to your developer account
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

Hot-reloads on every save (uses `vite build --watch` per `devvit.json`'s `scripts.dev`). Test the flow by clicking the join button and watching for the redirect chain to land you in your test Discord server.

## Project layout

- `devvit.json` - app config: permissions, settings schema, triggers, menu items, post entrypoints
- `src/server/index.ts` - Hono entrypoint, mounts `/api/*` and `/internal/*` routes
- `src/server/routes/triggers.ts` - `onModAction` handler (ban/unban relay)
- `src/server/routes/menu.ts` - "Create Discord-join post" and "Sync banned users" menu actions
- `src/server/routes/scheduler.ts` - bulk-sync-banned background task (paced + batched to dodge Reddit's outbound-fetch throttle)
- `src/server/routes/api.ts` - `POST /api/join-token` called by the webview button
- `src/server/core/` - HMAC signing, Discord webhook, Redis dedup
- `src/client/join.{html,ts,css}` - the join post webview rendered inside Reddit's iframe
- `src/shared/api.ts` - types shared between client and server

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

The bot's `src/web/server.ts` validates both the signature and the expiry before issuing an invite.

## Known limitations

- **Webhook URL leak** = anyone can spoof ban events. Lock the bridge channel down to mods/admins only.
- **Signing secret leak** = anyone can forge invite-link URLs and claim any Reddit username for any Discord account. Treat it as a credential.
- **Devvit app uninstall is silent** to the bot. If join-button clicks stop working, check the app at `https://developers.reddit.com/apps/fo40-bridge`.
- **Custom post button on mobile** has been mostly tested via playtest. Behavior on the official Reddit mobile app is generally OK; if a user reports the button doesn't work, fall back to `/link-reddit` mod-driven manual link.

## Devvit Web gotchas

Things that bit us during the Blocks-to-Devvit-Web migration and are worth knowing if you're touching this:

- **`permissions.reddit` must be declared explicitly** when a `permissions` block is present. If you set `permissions: { http, redis }` and leave out `reddit`, the schema's boolean default of `false` kicks in and every `reddit.*` gRPC call silently fails with `Error: undefined undefined: undefined` (empty status). Either declare `reddit: true` / `reddit: { enable: true, ... }`, or omit the `permissions` block entirely.
- **Post height needs a post-creation patch.** `submitCustomPost({ styles: { height: ... } })` currently crashes the platform with the same empty-status error (reddit/devvit#258). The entrypoint's `height: "regular"` in `devvit.json` is also not honored. Workaround in `src/server/routes/menu.ts`: call `post.setCustomPostStyles({ height: EntrypointHeight.REGULAR })` immediately after the post is created.
- **Menu/form endpoints should return HTTP 200 even on errors**, with the error message in `showToast`. Returning non-2xx triggers Devvit's generic "Something went wrong" toast and your `showToast` is discarded.
- **The `onModAction` trigger wire payload still uses the old shape** (`event.action`, `event.targetUser.name`, `event.moderator.name`, `event.actionedAt`, `event.subreddit.name`) even though the TypeScript `ModAction` interface uses different field names. The protobuf-JSON form is what arrives at the trigger endpoint, so the old field names are correct.

## License

BSD-3-Clause (matches the parent repo).
