# FriendsOver40 Discord Bot

Self-hosted, single-guild moderation and engagement bot for the [r/FriendsOver40](https://www.reddit.com/r/FriendsOver40) companion Discord server.

This is a private tool for one community, not a general-purpose bot. It is hardcoded to one guild, makes opinionated decisions for a 40+ friendship audience, and explicitly rejects features common to mainstream Discord bots (no XP/levels, no AI tone detection, no auto-moderating message content). If you want to fork it for your own server, **read [`SPEC.md`](SPEC.md) first** — the design rationale matters more than the code.

## What it does (so far)

- **Scheduled channel control.** Opens/closes channels on a cron schedule, optionally purges messages on close, posts an open announcement to a chosen channel, and posts a configurable warning before close. Used for Selfie Sunday — the channel is hidden Mon–Sat, opens Sun 00:00 PT, closes and wipes Mon 00:00 PT.
- **Mod notes & strikes.** `/note add|view|remove`, `/strike add|view`, `/history`. Severity 1 = warn (90-day expiry), 2 = timeout (1-28 days), 3 = ban (immediate). All actions logged to the configured mod-log channel.
- **Reddit → Discord ban sync (via Devvit bridge).** `/link-reddit`, `/unlink-reddit`, `/reddit-status`. Members link their Reddit username by pasting a one-time code into a form on the subreddit (added by a companion Devvit app — see `reddit_devvit/`). When a Reddit mod bans a user, the Devvit app posts to a Discord webhook in a dedicated bridge channel; the bot reads it and bans the linked Discord user. One-way; Discord-side bans don't propagate to Reddit. The bot holds no Reddit credentials. Self-disables if `BRIDGE_CHANNEL_ID`/`BRIDGE_WEBHOOK_ID` aren't in `.env`.

## What it will do

In rough build order:

1. **DM creeper reports** — `/report-dm` with screenshot attachment, mod queue with action buttons, auto-flag on repeat reports.
2. **Reaction roles** — self-assignable timezones, interests, life stage.
3. **Daily prompts** — rotating conversation starter posted to a chosen channel.
4. **Birthdays** — opt-in `/birthday set`, daily announcement, no year stored.

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

The bot expects these roles (names can differ — only the IDs in `.env` matter):

- `modbot` — the bot's own role. Position above `@everyone`, below `mods`/`admins`.
- `mods` — moderator role. `@mod_only()` commands require this (or `admins`).
- `admins` — admin role. Inherits mod privileges; also passes `@mod_only()`.
- `40+` — access-gate role assigned via onboarding. `@forty_plus_only()` commands require this.
- `underage` — assigned via onboarding to under-40 users. No special handling in code; lacking `40+` is what gates access.

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

## Layout

```
fo40-bot/
├── bot.py              # entry point
├── config.yaml         # runtime-tweakable: schedules, prompt pool
├── .env                # secrets, IDs (gitignored)
├── data/bot.db         # SQLite, persistent
├── core/
│   ├── __init__.py
│   ├── db.py           # schema, connection
│   ├── config.py       # env + YAML loader
│   ├── scheduling.py   # shared APScheduler
│   └── permissions.py  # role checks, slash command guards
├── cogs/
│   ├── __init__.py
│   ├── scheduler.py    # generalized scheduled-channel controller
│   ├── mod_notes.py    # /note, /strike, /history
│   └── reddit_sync.py  # /link-reddit, /unlink-reddit + bridge listener
└── reddit_devvit/      # companion Devvit app (TypeScript) — see its README
    ├── devvit.yaml
    ├── package.json
    └── src/main.tsx
```

Each feature is a cog in `cogs/`. Cogs are independently loadable — disable one by removing it from `INITIAL_COGS` in `bot.py`.

## Operational notes

- **`modbot` role placement matters.** The `modbot` role must be above `@everyone` and have explicit allow on managed channels, or the bot will lock itself out when hiding channels.
- **Don't grant Administrator.** Too much blast radius if the token leaks. Grant only the listed permissions.
- **Timezones.** Cron schedules in `config.yaml` use the `timezone` field per entry. The codebase uses `zoneinfo` (Python 3.9+).
- **Schema changes.** `core/db.py` runs idempotent CREATE statements on startup. For real schema changes later, add a migrations table and version-gated ALTERs.
- **Logs.** Container logs are JSON-rotated at 10MB × 3 files via `docker-compose.yml`. Tail with `docker compose logs -f`.

## Design rationale

See [`SPEC.md`](SPEC.md) — the source of truth for what the bot does, why, and what is explicitly out of scope.

## Companion Devvit app

The Reddit-side functionality (ban-sync + Reddit identity verification) is provided by a small TypeScript Devvit app in [`reddit_devvit/`](reddit_devvit/). It is uploaded to Reddit and runs sandboxed there; it is not part of this Python project's runtime. See its README for setup, deployment, and the privacy/terms documents required for App Review.

## License

BSD-3-Clause. Add a `LICENSE` file with the standard text and your copyright line if you fork this.
