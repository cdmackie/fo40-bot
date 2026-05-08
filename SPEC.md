# FriendsOver40 Discord Bot — Specification

This document is the source of truth for the FriendsOver40 Discord bot project. It describes the goal, the design decisions already made, what is implemented, and what remains to be built. It is intended as a handoff doc for Claude Code (or any agent/developer) to continue building from.

---

## 1. Project goal

A self-hosted, single-guild Discord bot for the **FriendsOver40 Discord server** (companion to the existing `r/FriendsOver40` subreddit). The bot exists to:

- Reduce moderator workload through automation (scheduled channels, mod notes, strikes, ban-sync).
- Protect a 40+ audience from problems disproportionately common in this demographic on social platforms — DM creepers, romance scammers, MLM solicitations.
- Promote engagement through opt-in, low-pressure features (daily prompts, birthdays, reaction roles).

This is **not a product**. It is a private tool for one server. Customise freely; do not generalise for multi-guild use.

---

## 2. Audience-driven design principles

Decisions throughout the codebase are informed by the fact that this serves a 40+ friendship (not dating) community. Specifically:

- **Friends, not dating** — features must not encourage or facilitate dating-app behaviour.
- **DM safety is paramount** — the demographic is targeted by creepers and scammers; the report flow is a flagship feature.
- **No surveillance feel** — features that read message content for sentiment, tone, or crisis-phrase detection are explicitly out of scope. Older adults dislike feeling monitored, and false positives are worse than the problem they aim to solve.
- **No gamification** — XP, levels, leaderboards, currency/economy bots are out of scope. The audience finds them childish.
- **Quiet by default** — bot announcements are infrequent and intentional. The bot should not be a chatty presence.

---

## 3. Stack & architectural decisions (already made — do not relitigate)

| Decision | Choice | Why |
| --- | --- | --- |
| Language / lib | Python 3.12 + `discord.py>=2.4` | Mature, async-native, good Cog pattern; matches operator's other Python work |
| Database | SQLite via `aiosqlite` | Single file, zero ops, fits one-server scope |
| Scheduling | `APScheduler` (`AsyncIOScheduler`) | Cron expressions, single shared instance across cogs |
| Config | `.env` for secrets/IDs, `config.yaml` for runtime-tweakable values | Clean separation of "must restart" vs "edit and reload" |
| Reddit API | `praw` (planned, not yet added) | For ban-sync and announcement mirror |
| Deployment | Docker Compose, self-hosted on operator's server | Operator preference |
| Architecture | discord.py Cogs, one feature per cog, independently loadable | Standard discord.py pattern, allows feature toggling |

**Single-guild assumption is hardcoded.** `GUILD_ID` is in `.env`, not config.yaml. Slash commands are guild-scoped, not global. Do not introduce multi-guild abstractions.

---

## 4. Project structure

```
fo40-bot/
├── bot.py                 # Entry point. Loads cogs, starts scheduler, runs gateway.
├── config.yaml            # Runtime-tweakable: schedules, prompt pool, reaction-role messages
├── .env                   # Secrets and IDs (gitignored)
├── .env.example           # Template for .env
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── README.md              # Operator-facing setup instructions
├── SPEC.md                # This file
├── data/
│   └── bot.db             # SQLite, persistent (gitignored)
├── core/                  # Shared infrastructure used by cogs
│   ├── __init__.py
│   ├── db.py              # Schema + connection helper
│   ├── config.py          # Settings dataclass, env+YAML loader
│   ├── scheduling.py      # Shared APScheduler instance + cron helper
│   └── permissions.py     # Role checks, slash command guards
├── cogs/                  # One file per feature
│   ├── __init__.py
│   ├── scheduler.py       # IMPLEMENTED — generalised scheduled-channel controller
│   ├── mod_notes.py       # IMPLEMENTED — /note, /strike, /history
│   ├── reddit_sync.py     # IMPLEMENTED — invite-link auto-verify + ban relay
│   # Planned but not yet implemented:
│   # ├── dm_reports.py
│   # ├── reaction_roles.py
│   # ├── prompts.py
│   # └── birthdays.py
├── web/                   # IMPLEMENTED
│   ├── __init__.py
│   └── server.py          # aiohttp server: GET /join handles invite-link tokens
└── reddit_devvit/         # Companion Devvit app (TypeScript). Uploaded to Reddit;
    ├── devvit.yaml        # not run by this Python project. See its README.
    ├── package.json
    ├── tsconfig.json
    └── src/main.tsx
```

---

## 5. What is implemented

### 5.1 Foundation (`core/`)

**`core/db.py`** — defines the full schema for *all* features (current and planned) as idempotent `CREATE TABLE IF NOT EXISTS` statements run on startup via `init_db()`. Tables for unbuilt cogs already exist; new cogs should use them rather than redefining schema. Exposes `connect()` returning an `aiosqlite` context manager.

**`core/config.py`** — `Settings` dataclass loaded from `.env` + `config.yaml`. Cached after first call. Access via `config.load()`. The `yaml_data` field on the dataclass holds the parsed YAML for cogs to read their own config sections from.

**`core/scheduling.py`** — singleton `AsyncIOScheduler` accessed via `get_scheduler()`. Helper `cron_trigger(expr, tz)` builds a `CronTrigger` from a 5-field cron expression and IANA timezone name. The scheduler is started in `bot.py`'s `setup_hook`; cogs add jobs to it during their `cog_load`.

**`core/permissions.py`** — exposes `is_moderator(member)`, `is_admin(member)`, `is_forty_plus(member)`, and the slash-command decorators `@mod_only()` and `@forty_plus_only()`. `is_moderator()` returns true for the `mods` **or** `admins` role; admins inherit mod privileges. The decorators raise `NotModerator` / `NotFortyPlus` (subclasses of `app_commands.CheckFailure`) on rejection; the global `tree.on_error` in `bot.py` catches these and sends an ephemeral message. New cogs **must** use these helpers rather than re-implementing role checks. Use `is_admin()` directly only for the rare command that admins-and-not-mods should run.

### 5.2 Entry point (`bot.py`)

- Subclasses `commands.Bot` as `FO40Bot`.
- Enables `intents.members`. `intents.message_content` is **off**; turn it on only if a future cog truly requires reading message text (most don't — slash commands work without it).
- `INITIAL_COGS` list controls which cogs load. **Add new cogs here** when implementing them.
- Slash commands sync to the guild on startup (`tree.sync(guild=...)`) for instant availability.

### 5.3 Scheduler cog (`cogs/scheduler.py`)

Implemented. Reads `scheduled_channels` from `config.yaml` and registers open/close/warn jobs with the shared scheduler. For each entry:

- **Open** — grants the gate role (default `@everyone`, configurable per channel via `gate_role_id`) view + send + read history on the channel; optionally posts an announcement to a different channel via `announce.open_message`.
- **Close** — revokes the gate role's view + send (channel becomes hidden from members holding only that role); optionally purges all non-pinned messages via `channel.purge()`.
- **Warn** — derives a "N minutes before close" cron via `_shift_cron()` and fires up to two messages: `announce.close_warning_message` posts inside the scheduled channel (warning the people present), and `announce.close_message` posts to the announce channel (broadcasting that close is imminent). Either or both may be set; the job is only registered if at least one is. The shift function handles minute/hour shifts that cross midnight back/forward by one day for numeric `dow` values, leaves `*` alone, and returns `None` for complex expressions.

**Per-entry config keys:**
| Key | Required | Purpose |
| --- | --- | --- |
| `name` | yes | Identifier used in logs and APScheduler job IDs |
| `channel_id` | yes | The channel being opened/closed |
| `open_cron` / `close_cron` | yes | 5-field cron expressions |
| `timezone` | yes | IANA tz name (e.g. `America/Los_Angeles`) |
| `gate_role_id` | no | Role whose access is toggled. Defaults to `@everyone`. Set to the `40+` role ID for FO40-style gating. |
| `purge_on_close` | no | Bool. If true, purges messages after close. |
| `skip_pinned` | no | Bool. Defaults to true. Skips pinned messages during purge. |
| `announce.channel_id` | no | Channel that receives `open_message` / `close_message` |
| `announce.open_message` | no | Posted to announce channel at open |
| `announce.close_warning_minutes` | no | How many minutes before close the warn job fires |
| `announce.close_warning_message` | no | Posted in the scheduled channel at warn time |
| `announce.close_message` | no | Posted to the announce channel at warn time |

**Class structure:**
- `ScheduledChannel` — encapsulates open/warn/close behaviour for one configured channel.
- `SchedulerCog` — discord.py Cog; on `cog_load`, instantiates a `ScheduledChannel` per YAML entry and registers jobs.

**Hardcoded behaviours:**
- Hide-then-purge ordering on close (so users don't watch deletion happen).
- 2-second delay between hide and purge.
- Pinned messages skipped during purge by default (`skip_pinned: true` is the default).

### 5.4 Deployment

- `Dockerfile` builds a slim Python 3.12 image with `tzdata` installed.
- `docker-compose.yml` mounts `./data` for the SQLite DB and `./config.yaml` read-only into the container; rotates JSON logs at 10MB × 3 files.
- Run with `docker compose up -d --build`.

---

## 6. Data model (full)

All tables are defined in `core/db.py`. Tables for unbuilt cogs are already created so new cogs can use them immediately.

| Table | Status | Purpose |
| --- | --- | --- |
| `schema_version` | reserved | For future migration tracking; unused today |
| `users` | implemented | Lazy-created user record (auto-created on first mod action via `INSERT OR IGNORE`); stores `reddit_username` for ban-sync. No denormalised counters — `SELECT COUNT(*)` on demand is cheap at this scale. |
| `mod_notes` | schema ready | One row per private mod note attached to a user |
| `strikes` | schema ready | One row per strike with severity (1=warn, 2=timeout, 3=ban), reason, optional `expires_at` |
| `dm_reports` | schema ready | One row per `/report-dm` submission with status workflow. `mod_channel_message_id` tracks the posted mod-queue message so a later cleanup job can edit it for screenshot redaction. |
| `birthdays` | schema ready | Opt-in user → (month, day). No year stored, intentionally |
| `reaction_role_messages` | schema ready | Maps a posted message to its emoji→role config (JSON column) |
| `prompts` | schema ready | Pool of daily-prompt strings with `last_used` for rotation |
| `ban_sync_log` | implemented | Audit trail for Reddit → Discord ban mirroring |

When implementing a cog, **read from and write to these existing tables** rather than introducing new schema. If a new column is genuinely needed, add it to the `SCHEMA` list in `core/db.py` as an idempotent `ALTER` and bump `schema_version`.

---

## 7. Conventions for new code

These match the patterns established in the implemented code. Follow them.

- **Logging.** Each module declares `log = logging.getLogger("fo40.<area>")` (e.g. `"fo40.scheduler"`). Use structured messages: `log.info("[%s] opened", self.name)`. Don't print.
- **Error handling.** Don't swallow exceptions silently. If a guild/channel/role isn't found, `log.warning(...)` and return; don't crash the cog.
- **Permission gating.** Use `@mod_only()` and `@forty_plus_only()` from `core.permissions`. Don't re-implement role checks inline.
- **DB access.** Use `async with db.connect() as conn:` and `await conn.commit()`. Don't open raw `aiosqlite` connections.
- **Scheduling.** Get the shared scheduler via `get_scheduler()`. Use `replace_existing=True` when adding jobs so reloads don't duplicate.
- **Config.** Read your cog's section from `config.load().yaml_data` (e.g. `yaml_cfg.get("daily_prompt", {})`). IDs and secrets that are sensitive belong in `.env` (extend `Settings`); runtime-tweakable values belong in `config.yaml`.
- **Slash commands.** Define as `@app_commands.command(...)` methods on the cog. Use `interaction.response.send_message(..., ephemeral=True)` for mod-only responses by default to keep mod chatter private.
- **Cog loading.** Each cog file ends with `async def setup(bot): await bot.add_cog(...)`. Add the new cog's import path to `INITIAL_COGS` in `bot.py`.
- **No new dependencies without justification.** Current deps: `discord.py`, `apscheduler`, `aiosqlite`, `PyYAML`, `python-dotenv`. `praw` will be added for `reddit_sync`. Anything else needs a real reason.

---

## 8. Roadmap — cogs to build

Listed in recommended build order. Each entry specifies the purpose, slash command surface, DB tables, and implementation notes. Build one cog at a time, test, then move to the next.

### 8.1 `cogs/mod_notes.py` — Mod notes & strikes (IMPLEMENTED)

**Purpose:** Persistent, private record of moderator observations and disciplinary actions on users. Foundation for `dm_reports` and any future moderation feature.

**Slash commands** (all `@mod_only()`, all responses ephemeral):
- `/note add user:<user> note:<text>` — Adds a row to `mod_notes`.
- `/note view user:<user>` — Replies with all notes on the user, newest first.
- `/note remove note_id:<int>` — Deletes a specific note.
- `/strike add user:<user> severity:<1|2|3> reason:<text> [duration_days:<int>]` — Records a strike. Severity 2 (timeout) requires `duration_days` (1-28; Discord's max). Severity 3 (ban) executes immediately — there is no confirmation step (decided 2026-05-08). The Discord-side action runs first; if it fails, no strike row is recorded.
- `/strike view user:<user>` — Shows active strikes (`expires_at` null or future).
- `/history user:<user>` — Combined chronological view: notes + strikes + dm_reports where user is reporter or reported.

**Severity → Discord action / expiry:**
| Severity | Discord action | `expires_at` |
| --- | --- | --- |
| 1 (warn) | none | now + 90 days |
| 2 (timeout) | `member.timeout(duration_days)` | now + duration_days |
| 3 (ban) | `guild.ban(user)` (immediate) | NULL (permanent) |

**DB tables:** `users`, `mod_notes`, `strikes`.

**Notes:**
- All actions post a structured embed to `MOD_LOG_CHANNEL_ID` (color-coded per severity) with the acting mod, target user, and details.
- `users` rows are auto-created on first action via `INSERT OR IGNORE`. `joined_at` is left NULL until/unless an `on_member_join` listener populates it.
- User parameters use `discord.User` (not `Member`) so commands work for users who have left or been banned.
- Module-level helpers (`add_note`, `add_strike`, `get_history`, `log_action`, etc.) are exported so `dm_reports` can record actions through this cog rather than re-implementing the DB layer.

### 8.2 `cogs/dm_reports.py` — DM creeper reports

**Purpose:** Allow members to report unsolicited or inappropriate DMs. Mods triage from a queue.

**Slash commands:**
- `/report-dm reported_user:<member> screenshot:<attachment> [context:<text>]` — `@forty_plus_only()`. Creates a `dm_reports` row with status `'open'`. Posts the report to a mod channel (configured via `dm_reports.mod_channel` in YAML) with action buttons.
- `/dm-reports list [status:<open|reviewing|actioned|dismissed>]` — `@mod_only()`. Lists reports.
- `/dm-reports show id:<int>` — `@mod_only()`. Shows full report.

**Mod channel UI:** Use `discord.ui.View` with buttons:
- Dismiss → status `'dismissed'`, log to mod-log channel.
- Add Note → opens modal, calls into `mod_notes` to add a note on the reported user.
- Strike → opens modal for severity + reason, calls into `mod_notes` to add a strike.
- Ban → ban the reported user, status `'actioned'`.

**Auto-flag:** When a user accumulates 3 open or actioned reports, post a high-priority alert in the mod channel pinging the moderator role. Threshold configurable via `dm_reports.auto_flag_threshold` in YAML.

**DB tables:** `dm_reports`, plus calls into `mod_notes`/`strikes`.

**Privacy / retention:**
- Screenshots are stored as Discord CDN URLs (the attachment URL Discord returns when the user uploads). Do not download and re-host.
- When a report is resolved (`'actioned'` or `'dismissed'`), keep the row but set `screenshot_url = NULL` after 30 days via a daily cleanup job, and edit the original mod-channel message to redact the image. This minimises long-term retention of sensitive imagery.

### 8.3 `cogs/reaction_roles.py` — Self-assignable roles

**Purpose:** Members assign themselves roles (timezone, interests, life stage, pronouns) by reacting to bot-posted messages.

**Slash commands** (all `@mod_only()`):
- `/rr-create channel:<channel> title:<text> description:<text>` — Posts an embed. Returns the message ID.
- `/rr-add-role message_id:<int> emoji:<str> role:<role>` — Adds an emoji→role mapping to that message. Updates `reaction_role_messages.config_json`. Bot adds the reaction to the message.
- `/rr-remove-role message_id:<int> emoji:<str>` — Reverse.

**Listeners:**
- `on_raw_reaction_add` — if `payload.message_id` is in `reaction_role_messages` and the emoji maps to a role, add the role to the user.
- `on_raw_reaction_remove` — reverse.

**DB tables:** `reaction_role_messages` (config stored as JSON in `config_json`).

**Notes:**
- Use raw events (not `on_reaction_add`) so they fire for messages not in cache.
- Ignore reactions from the bot itself.

### 8.4 `cogs/prompts.py` — Daily conversation prompts

**Purpose:** Posts a rotating conversation prompt to a designated channel each day.

**Slash commands** (all `@mod_only()`):
- `/prompt add text:<str> [category:<str>]`
- `/prompt remove id:<int>`
- `/prompt list [category:<str>]`
- `/prompt post-now` — fires the daily post immediately.

**Schedule:** APScheduler cron from `config.yaml` (`features.daily_prompt.cron`, `features.daily_prompt.timezone`). On fire, picks the prompt with the oldest `last_used` (NULL counts as oldest), posts it, updates `last_used`.

**DB tables:** `prompts`.

**Notes:**
- Initial prompt seeding can be done via `/prompt add` post-deploy, or by extending `db.init_db()` to insert a starter set if the table is empty.

### 8.5 `cogs/birthdays.py` — Birthday tracking

**Purpose:** Members opt in to birthday tracking; bot announces birthdays daily.

**Slash commands:**
- `/birthday set month:<1-12> day:<1-31>` — `@forty_plus_only()`. Validates the date (handle Feb 29 → store as Feb 28 with a note, or reject and require Feb 28). Upserts into `birthdays`.
- `/birthday remove` — Deletes the user's row.
- `/birthday today` — Lists members whose birthday is today (mod or anyone — your call; default to anyone).

**Schedule:** Daily cron from `config.yaml` (`features.birthdays.cron`, `features.birthdays.timezone`). Posts to the configured announce channel.

**DB tables:** `birthdays`.

**Privacy:** Year is **never** stored. The schema enforces this.

### 8.6 `cogs/reddit_sync.py` — Reddit ↔ Discord integration (IMPLEMENTED)

**Two integrations, sharing a Devvit companion app:**

#### A. Modlog ban relay (Reddit → Discord)

When a moderator bans a user on r/FriendsOver40, the Devvit app POSTs a structured embed to a Discord webhook in a private bridge channel. This cog's `on_message` listener picks it up and bans the linked Discord user. Discord-side bans do NOT propagate back to Reddit. Announcement mirroring is out of scope.

#### B. Invite-link join flow (Reddit → Discord, with auto-verification)

The Devvit app provides a custom post type "Join Discord" that mods pin to r/FriendsOver40. When a logged-in Reddit user clicks the post's button:

1. The Devvit app reads their Reddit username and signs an HMAC-SHA256 token containing `{u: username, e: expiry}` using `signing_secret` (shared with the bot).
2. Devvit `navigateTo`s `bot_join_url?token=...`, which is the bot's web server.
3. The bot (`web/server.py`) verifies the signature and expiry.
4. The bot creates a one-time-use Discord invite for `INVITE_CHANNEL_ID` (max_uses=1, max_age=10min) and stores `{invite_code: reddit_username}` in `pending_invites`.
5. The bot redirects the browser to `https://discord.gg/<invite_code>`.
6. The user joins Discord normally.
7. The cog's `on_member_join` listener compares pre/post invite-use counts to identify which invite was used, looks up `pending_invites`, saves `users.reddit_username`, and assigns the `40+` role. The pending row is then deleted.

User-facing experience: **two clicks** (the Reddit post button + Discord's "Accept invite" prompt). No slash commands, no codes, no forms. Reddit identity is auto-verified via Devvit's auth context.

**Architecture rationale:** Reddit closed the script-app API path in late 2025 in favour of Devvit. Direct PRAW/asyncpraw access is no longer available. Devvit apps run sandboxed on Reddit but can POST to allowlisted external domains (`discord.com` is on the global allowlist; the bot's web server's domain doesn't need allowlisting because the Devvit app navigates the user's browser there rather than fetching server-to-server).

All Devvit settings (`discord_webhook_url`, `signing_secret`, `bot_join_url`) are **installation-scoped** so multiple subreddits can install the same app and point it at their own Discord servers/bots independently.

**Slash commands** (mod-only — users don't need to do anything; auto-link happens via the join flow):
- `/link-reddit user:<user> username:<str>` — manually link a Discord user to a Reddit username (e.g. for users who joined via a different invite or whose auto-link failed).
- `/unlink-reddit user:<user>` — remove a user's link.
- `/reddit-status [user:<user>]` — show linked Reddit username (anyone for self; mods for others).

**DB tables:** `users` (the link), `ban_sync_log`, `pending_invites` (transient mapping invite_code → reddit_username, consumed on member join).

**Required env vars** (bot side, in `.env`):
- `BRIDGE_CHANNEL_ID`, `BRIDGE_WEBHOOK_ID` — bridge channel + webhook for ban relay
- `BRIDGE_SIGNING_SECRET` — shared HMAC secret with Devvit's `signing_secret`
- `BOT_PUBLIC_URL` — public URL the bot serves on (must match Devvit's `bot_join_url`)
- `WEB_SERVER_PORT` — local listen port (default 8080)
- `INVITE_CHANNEL_ID` — channel new members are invited into

The bot's web server self-disables if any of `BRIDGE_SIGNING_SECRET`, `INVITE_CHANNEL_ID`, or `BOT_PUBLIC_URL` is missing. The on_message bridge listener self-disables if either `BRIDGE_CHANNEL_ID` or `BRIDGE_WEBHOOK_ID` is missing.

**Discord permissions the bot needs:**
- `Create Instant Invite` on the invite channel (to create one-time invites)
- `Manage Server` or `View Audit Log` on the guild (to list invites for the use-count comparison in `on_member_join`)
- `Manage Roles` (to assign the 40+ role)
- `Ban Members` (for ban relay)

The bot itself has **no Reddit credentials** and makes **no Reddit API calls**.

```
[Reddit modlog ban]
        ↓
[Devvit app's ModAction trigger fires]
        ↓
[Devvit POSTs embed to Discord webhook URL]
        ↓
[Webhook lands message in #reddit-bridge channel]
        ↓
[Bot's on_message picks it up, applies Discord ban]
```

For verification, the flow inverts: the user clicks "Link Discord account" in the subreddit menu (added by the Devvit app), pastes a code that the bot generated via `/link-reddit`, and Devvit posts the `{reddit_username, code}` pair to the same webhook. The bot matches the code to a pending verification and writes the link.

**Dependencies:** `praw>=7.7` (add to `requirements.txt`). New env vars in `.env`:
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USERNAME`
- `REDDIT_PASSWORD`
- `REDDIT_USER_AGENT` (e.g. `"fo40-bot/0.1 by u/<operator>"`)

**Webhook embed protocol** (set by the Devvit app, read by the bot's `on_message` listener in the bridge channel):

| `embed.title` | Fields | Action |
| --- | --- | --- |
| `[fo40-bridge] ban` | `reddit_username`, `moderator`, `reason` | Look up linked Discord user; ban with reason; log to `ban_sync_log` and `MOD_LOG_CHANNEL_ID`. If unmatched, log and post a heads-up. |

The bot filters by both `message.channel.id == BRIDGE_CHANNEL_ID` and `message.webhook_id == BRIDGE_WEBHOOK_ID`.

**Out of scope:**
- Discord-ban → Reddit-ban (outbound sync). Blast radius too high; mods can ban on Reddit manually if needed.
- Announcement-flair post mirroring. Operator does not use this workflow.

**Caveats / risks:**
- Identity verification depends on the Devvit app correctly reading `context.reddit.getCurrentUser()` for the Reddit username. The signing secret prevents URL forgery, but if Reddit's auth is compromised the chain breaks at that point.
- The Discord webhook URL and the signing secret are the trust boundaries. Both must be stored only in the Devvit app's installation settings (encrypted at rest by Reddit) and the bot's `.env`.
- If `BOT_PUBLIC_URL` becomes unreachable, the join button on Reddit fails for users; they see a Devvit toast. The Devvit ban relay is unaffected because it goes directly to Discord's webhook URL.
- The bot needs to keep its invite cache in sync. After a restart it rebuilds from `Guild.invites()` on `on_ready`. Anyone joining during the brief window before `on_ready` may not get auto-linked; mods can use `/link-reddit` to fix.

---

## 9. Things explicitly out of scope

Do not build these. They have been considered and rejected:

- **AI tone / sentiment / aggression detection.** False positives feel like surveillance to a 40+ audience. Humans stay in the loop; the bot routes flags but does not act on tone.
- **Crisis-phrase auto-DM with hotlines.** A bot replying to "I'm so done" with a suicide hotline link is jarring and potentially harmful. Pin a resources channel manually instead.
- **XP, levels, leaderboards, currency, economy bots.** The audience finds them childish.
- **Ticket bot / support-thread complexity.** A simple `#mod-help` channel is sufficient for current scale.
- **Multi-guild support.** This bot serves one server. Do not abstract for reuse.
- **Auto-moderating message content** (slurs, spam patterns, etc.) — defer to Discord's built-in AutoMod feature for now.

---

## 10. Discord server setup requirements

These are operator responsibilities, but new cogs may depend on them. Verify before building cogs that interact with channels or roles.

1. **Bot role placement.** The `modbot` role exists, positioned above `@everyone` and below `mods`/`admins`. Do not grant Administrator.
2. **Per-channel permissions for the bot.** On every channel the bot manages (e.g. `#selfie-sunday`), the `modbot` role is explicitly granted: View Channel, Send Messages, Manage Messages, Manage Channels. Without this, hiding a channel from `@everyone` locks the bot out too.
3. **Existing role gating.** The server uses an onboarding question that assigns either `40+` or `underage`. The `40+` role is the access gate; `@everyone` has no channel access. Bot features that should require verified-age members use `@forty_plus_only()` (which checks for `40+`). The `underage` role needs no special handling — lacking `40+` is what gates access.
4. **Privileged Gateway Intents.** Server Members Intent must be enabled in the Discord Developer Portal. Message Content Intent is currently **off** and should remain off unless a future cog genuinely needs to read message text.

---

## 11. Open decisions / things to confirm with operator

If you (Claude Code) hit one of these while building, surface it to the operator rather than picking arbitrarily:

- **Daily prompt seed list.** Initial prompt content is operator-provided. Don't invent prompts; ask.
- **Birthday Feb 29 handling.** Spec proposes "store as Feb 28." Could also reject. Confirm.

---

## 12. How to extend

When adding a new cog:

1. Create `cogs/<name>.py`.
2. Use `core/` helpers (`db.connect()`, `config.load()`, `get_scheduler()`, `permissions.*`).
3. Use the appropriate existing DB tables. Only extend `core/db.py` if a column is genuinely missing.
4. Add the cog path to `INITIAL_COGS` in `bot.py`.
5. Add any new YAML config under a top-level key matching the feature (e.g. `daily_prompt:`).
6. Add new env vars to `.env.example` and to `Settings` in `core/config.py` if they're sensitive/operational.
7. Update this spec's roadmap section to mark the cog implemented.
8. Update `README.md`'s "What it does" list.

When in doubt, match the patterns in `cogs/scheduler.py` and `core/`.
