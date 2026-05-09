# FriendsOver40 Discord Bot

Self-hosted, single-guild moderation and engagement bot for the [r/FriendsOver40](https://www.reddit.com/r/FriendsOver40) companion Discord server.

This is a private tool for one community, not a general-purpose bot. It is hardcoded to one guild, makes opinionated decisions for a 40+ friendship audience, and explicitly rejects features common to mainstream Discord bots (no XP/levels, no AI tone detection, no auto-moderating message content). If you want to fork it for your own server, **read [`SPEC.md`](SPEC.md) first** - the design rationale matters more than the code.

## What it does (so far)

- **Scheduled channel control.** Opens/closes channels on a cron schedule, optionally purges messages on close, posts an open announcement to a chosen channel, and posts a configurable warning before close. Used for Selfie Sunday - the channel is hidden Mon–Sat, opens Sun 00:00 PT, closes and wipes Mon 00:00 PT.
- **Mod notes & strikes.** `/note add|view|remove`, `/strike add|view`, `/history`. Severity 1 = warn (90-day expiry), 2 = timeout (1-28 days), 3 = ban (immediate). All actions logged to the configured mod-log channel.
- **DM creeper reports.** `/report user:<member> context:<text>` (40+ only). Posts a triage card to the mod-log channel with one-click Dismiss / Add Note / Strike / Ban buttons. Strike and Add Note open modals; Ban executes immediately. Each report pings the mods role; no thresholds. Reports are text-only — no screenshot uploads. Cross-module: actions go through the same modNotes pipeline that powers `/note` and `/strike`, so they show up in `/history` too.
- **Reddit ↔ Discord integration (via Devvit + bot web server).** Two halves:
  - **Invite-link join flow.** A pinned post on r/FriendsOver40 (see `reddit_devvit/`) has a "Get Discord invite" button. Clicking it signs the user's Reddit username with an HMAC token and redirects through the bot's web server, which creates a one-time-use Discord invite and sends them to discord.gg. On member join, the bot auto-links the Discord account to the Reddit username and assigns the `40+` role. **User experience: two clicks.**
  - **Ban relay.** When a Reddit mod bans a user on r/FriendsOver40, the Devvit app posts to a private bridge channel on Discord; the bot reads it and bans the linked Discord user. One-way only.
  - Mod commands: `/link-reddit`, `/unlink-reddit`, `/reddit-status` (manual link/unlink for edge cases).

## What it will do

In rough build order:

1. **Reaction roles** - self-assignable timezones, interests, life stage.
3. **Daily prompts** - rotating conversation starter posted to a chosen channel.
4. **Birthdays** - opt-in `/birthday set`, daily announcement, no year stored.

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications, create a new application, add a Bot.
2. Under **Bot**, copy the token (this is your `DISCORD_TOKEN`).
3. Enable **Server Members Intent** under Privileged Gateway Intents.
4. Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`, and bot permissions:
   - View Channels
   - Send Messages
   - Manage Messages
   - Manage Channels
   - Manage Roles
   - Read Message History
5. Visit the generated URL and invite the bot to the FO40 server.

### 2. Configure roles in Discord

The bot expects these roles (names can differ - only the IDs in `.env` matter):

- `modbot` - the bot's own role. Position above `@everyone`, below `mods`/`admins`.
- `mods` - moderator role. `@mod_only()` commands require this (or `admins`).
- `admins` - admin role. Inherits mod privileges; also passes `@mod_only()`.
- `40+` - access-gate role assigned via onboarding. `@forty_plus_only()` commands require this.
- `underage` - assigned via onboarding to under-40 users. No special handling in code; lacking `40+` is what gates access.

On every channel the bot will manage (e.g. `#selfie-sunday`), explicitly grant the `modbot` role: View Channel, Send Messages, Manage Messages, Manage Channels. Without this, when the bot hides the channel from `@everyone`, it will lock itself out too.

### 3. Fill in `.env`

```bash
cp .env.example .env
```

Then edit `.env` with the IDs. To get IDs in Discord: enable Developer Mode (User Settings → Advanced), then right-click anything → Copy ID.

### 4. Create `config.yaml`

```bash
cp config.yaml.example config.yaml
```

Then edit `config.yaml` with your channel and role IDs. The example file shows the structure; placeholders are zeros.

### 5. Run

```bash
docker compose up -d --build
docker compose logs -f
```

The first run creates `data/bot.db` and registers slash commands with the guild.

For local development without Docker:

```bash
npm install
npm run dev    # tsx with watch - hot-reloads on changes
# or
npm run build && npm start
```

## Layout

```
fo40-bot/
├── src/
│   ├── index.ts          # entry point
│   ├── bot.ts            # client + command registration + lifecycle
│   ├── core/
│   │   ├── config.ts     # env + YAML loader
│   │   ├── db.ts         # better-sqlite3 + schema
│   │   ├── scheduling.ts # croner-based job runner
│   │   ├── permissions.ts# role checks + interaction guards
│   │   └── types.ts      # BotModule interface
│   ├── modules/          # one file per feature ("cogs")
│   │   ├── scheduler.ts  # scheduled-channel controller
│   │   ├── modNotes.ts   # /note, /strike, /history
│   │   ├── redditSync.ts # /link-reddit (mod), /reddit-status, member-join auto-link, ban-relay listener
│   │   └── dmReports.ts  # /report + mod queue with action buttons
│   └── web/
│       └── server.ts     # fastify: GET /join issues one-time Discord invite from signed token
├── package.json          # node deps + scripts
├── tsconfig.json
├── Dockerfile            # node:20-alpine, multi-stage build
├── docker-compose.yml
├── config.yaml           # runtime-tweakable: schedules (gitignored)
├── config.yaml.example   # template
├── .env                  # secrets, IDs (gitignored)
├── .env.example          # template
├── data/bot.db           # SQLite, persistent
└── reddit_devvit/        # companion Devvit app (TypeScript) - see its README
    ├── devvit.yaml
    ├── package.json
    └── src/main.tsx
```

Each feature is a cog in `cogs/`. Cogs are independently loadable - disable one by removing it from `INITIAL_COGS` in `bot.py`.

## Operational notes

- **`modbot` role placement matters.** The `modbot` role must be above `@everyone` and have explicit allow on managed channels, or the bot will lock itself out when hiding channels.
- **Don't grant Administrator.** Too much blast radius if the token leaks. Grant only the listed permissions.
- **Timezones.** Cron schedules in `config.yaml` use the `timezone` field per entry. The codebase uses `zoneinfo` (Python 3.9+).
- **Schema changes.** `core/db.py` runs idempotent CREATE statements on startup. For real schema changes later, add a migrations table and version-gated ALTERs.
- **Logs.** Container logs are JSON-rotated at 10MB × 3 files via `docker-compose.yml`. Tail with `docker compose logs -f`.

## Design rationale

See [`SPEC.md`](SPEC.md) - the source of truth for what the bot does, why, and what is explicitly out of scope.

## Companion Devvit app

The Reddit-side functionality (ban-sync + Reddit identity verification) is provided by a small TypeScript Devvit app in [`reddit_devvit/`](reddit_devvit/). It is uploaded to Reddit and runs sandboxed there; it is not part of this Python project's runtime. See its README for setup, deployment, and the privacy/terms documents required for App Review.

## License

BSD-3-Clause. Add a `LICENSE` file with the standard text and your copyright line if you fork this.
