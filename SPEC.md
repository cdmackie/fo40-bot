# FriendsOver40 Discord Bot - Specification

This document is the source of truth for the FriendsOver40 Discord bot project. It describes the goal, the design decisions already made, what is implemented, and what remains to be built. It is intended as a handoff doc for Claude Code (or any agent/developer) to continue building from.

---

## 1. Project goal

A self-hosted, single-guild Discord bot for the **FriendsOver40 Discord server** (companion to the existing `r/FriendsOver40` subreddit). The bot exists to:

- Reduce moderator workload through automation (scheduled channels, mod notes, strikes, ban-sync).
- Protect a 40+ audience from problems disproportionately common in this demographic on social platforms - DM creepers, romance scammers, MLM solicitations.
- Promote engagement through opt-in, low-pressure features (daily prompts, birthdays, reaction roles).

This is **not a product**. It is a private tool for one server. Customise freely; do not generalise for multi-guild use.

---

## 2. Audience-driven design principles

Decisions throughout the codebase are informed by the fact that this serves a 40+ friendship (not dating) community. Specifically:

- **Friends, not dating** - features must not encourage or facilitate dating-app behaviour.
- **DM safety is paramount** - the demographic is targeted by creepers and scammers; the report flow is a flagship feature.
- **No surveillance feel** - features that read message content for sentiment, tone, or crisis-phrase detection are explicitly out of scope. Older adults dislike feeling monitored, and false positives are worse than the problem they aim to solve.
- **No gamification** - XP, levels, leaderboards, currency/economy bots are out of scope. The audience finds them childish.
- **Quiet by default** - bot announcements are infrequent and intentional. The bot should not be a chatty presence.

---

## 3. Stack & architectural decisions (already made - do not relitigate)

| Decision | Choice | Why |
| --- | --- | --- |
| Language / lib | Node.js 20+ + `discord.js@^14` | TypeScript-first, mature; matches operator's stack |
| HTTP server | `fastify` (in-process with the bot) | Same Node process owns both the Discord gateway connection and the `/join` HTTP endpoint - single Docker container |
| Database | SQLite via `better-sqlite3` (sync, fast at our scale) | Single file, zero ops, fits one-server scope |
| Scheduling | `croner` | Cron expressions, IANA tz support, simple lifecycle |
| Config | `.env` for secrets/IDs, `config.yaml` for runtime-tweakable values | Clean separation of "must restart" vs "edit and reload" |
| Reddit integration | Companion Devvit app at `reddit_devvit/` (TypeScript), no Reddit API access on the bot | Reddit closed script-app API access; Devvit is the only path |
| Deployment | Docker Compose, self-hosted on operator's server (often behind nginx) | Operator preference |
| Architecture | Modular: each feature is a `BotModule` exporting commands + listeners; `bot.ts` loads them all | Standard discord.js pattern, allows feature toggling |

**Single-guild assumption is hardcoded.** `GUILD_ID` is in `.env`, not config.yaml. Slash commands are guild-scoped, not global. Do not introduce multi-guild abstractions.

---

## 4. Project structure

```
fo40-bot/
├── src/
│   ├── index.ts           # Entry point - calls bot.run()
│   ├── bot.ts             # Discord Client + command registration + signal handling
│   ├── core/
│   │   ├── config.ts      # Settings interface, env + YAML loader
│   │   ├── db.ts          # better-sqlite3 + schema
│   │   ├── scheduling.ts  # croner job registry + cron-shift helper
│   │   ├── permissions.ts # isModerator/isFortyPlus + interaction guards
│   │   └── types.ts       # BotModule interface
│   ├── modules/           # One file per feature
│   │   ├── scheduler.ts   # IMPLEMENTED - generalised scheduled-channel controller
│   │   ├── modNotes.ts    # IMPLEMENTED - /note, /strike, /history
│   │   ├── redditSync.ts  # IMPLEMENTED - invite-link auto-verify + ban relay
│   │   ├── dmReports.ts   # IMPLEMENTED - /report + mod queue with buttons
│   │   # Planned but not yet implemented:
│   │   # ├── reactionRoles.ts
│   │   # ├── prompts.ts
│   │   # └── birthdays.ts
│   └── web/
│       └── server.ts      # IMPLEMENTED - fastify server: GET /join handles invite-link tokens
├── package.json
├── tsconfig.json
├── Dockerfile             # node:20-alpine, multi-stage
├── docker-compose.yml
├── config.yaml.example    # Template; copy to config.yaml and fill in
├── .env.example           # Template; copy to .env and fill in
├── data/
│   └── bot.db             # SQLite, persistent (gitignored)
└── reddit_devvit/         # Companion Devvit Web app (TypeScript). Uploaded to Reddit;
    ├── devvit.json        # not run by this Node project. See its README.
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/{client,server,shared}/
```

---

## 5. What is implemented

### 5.1 Foundation (`src/core/`)

**`src/core/db.ts`** - defines the full schema for *all* features (current and planned) as idempotent `CREATE TABLE IF NOT EXISTS` statements in the `SCHEMA` array, run on first call to `getDb()`. Tables for unbuilt modules already exist; new modules should use them rather than redefining schema. `getDb()` returns a memoised `better-sqlite3` `Database` handle (synchronous). `closeDb()` is called from `bot.ts` during shutdown.

**`src/core/config.ts`** - `loadSettings()` reads `.env` + `config.yaml` and returns a `Settings` object. Cached after first call. The `yaml` field holds the parsed YAML for modules to read their own config sections from. ID fields in YAML are normalised to strings (Discord snowflakes exceed JS Number precision).

**`src/core/scheduling.ts`** - thin wrapper around `croner`. Modules register jobs with `addJob(id, expr, tz, handler)`; the unique `id` lets a hot-reload replace the existing job rather than duplicate it. `shiftCron(expr, minutesDelta)` derives a "N minutes before/after" cron from a 5-field expression, handling minute/hour shifts that cross midnight back/forward by one day for numeric `dow` values, leaving `*` alone, and returning `null` for complex expressions. `shutdownScheduler()` stops all registered jobs.

**`src/core/permissions.ts`** - exposes `isModerator(member)`, `isAdmin(member)`, `isFortyPlus(member)`, and the interaction guards `requireModerator(interaction)` / `requireFortyPlus(interaction)`. `isModerator()` returns true for the `mods` **or** `admins` role; admins inherit mod privileges. The `require*` helpers reply ephemerally with a "not authorised" message and return `false` if the check fails; the calling command then returns early. New modules **must** use these helpers rather than re-implementing role checks. Use `isAdmin()` directly only for the rare command that admins-and-not-mods should run.

**`src/core/types.ts`** - defines `BotModule { name, commands?, init? }` and `ModuleCommand { data, execute }`. Every feature exports a default `BotModule`; `bot.ts` collects them into the `MODULES` array.

### 5.2 Entry point (`src/bot.ts`)

- Constructs a `discord.js` `Client` with intents `Guilds`, `GuildMembers`, `GuildMessages`. `MessageContent` is **off**; turn it on only if a future module truly requires reading message text (most don't - slash commands work without it).
- The `MODULES` array controls which modules load. **Add new modules here** when implementing them.
- On startup: registers all module commands with the guild via `REST().put(Routes.applicationGuildCommands(...))` for instant availability, then calls each module's `init(client)` hook to attach event listeners.
- Dispatches `interactionCreate` events to the right module command handler via a name → handler map. Catches errors and replies ephemerally rather than crashing.
- Handles `SIGINT` / `SIGTERM` by closing the gateway, the DB, and the scheduler before exit.

### 5.3 Scheduler module (`src/modules/scheduler.ts`)

Implemented. Reads `scheduled_channels` from `config.yaml` and registers open/close/warn jobs via `addJob()`. For each entry:

- **Open** - grants the gate role (default `@everyone`, configurable per channel via `gate_role_id`) View Channel + Send Messages + Read Message History on the channel; optionally posts an announcement to a different channel via `announce.open_message`.
- **Close** - revokes the gate role's View Channel + Send Messages (channel becomes hidden from members holding only that role); optionally purges all non-pinned messages via `channel.bulkDelete()` in batches.
- **Warn** - derives a "N minutes before close" cron via `shiftCron()` and fires up to two messages: `announce.close_warning_message` posts inside the scheduled channel (warning the people present), and `announce.close_message` posts to the announce channel (broadcasting that close is imminent). Either or both may be set; the job is only registered if at least one is.

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

**Code structure:**
- `ScheduledChannel` class encapsulates open/warn/close behaviour for one configured channel.
- Module's `init()` hook instantiates a `ScheduledChannel` per YAML entry and registers their jobs.

**Hardcoded behaviours:**
- Hide-then-purge ordering on close (so users don't watch deletion happen).
- 2-second delay between hide and purge.
- Pinned messages skipped during purge by default (`skip_pinned: true` is the default).

### 5.4 Deployment

- `Dockerfile` builds a slim `node:20-alpine` image with `tzdata` installed and runs `node dist/index.js`.
- `docker-compose.yml` mounts `./data` for the SQLite DB and `./config.yaml` read-only into the container; rotates JSON logs at 10MB × 3 files.
- Run with `docker compose up -d --build`.

---

## 6. Data model (full)

All tables are defined in `src/core/db.ts`. Tables for unbuilt modules are already created so new modules can use them immediately.

| Table | Status | Purpose |
| --- | --- | --- |
| `schema_version` | reserved | For future migration tracking; unused today |
| `users` | implemented | Lazy-created user record (auto-created on first mod action via `INSERT OR IGNORE`); stores `reddit_username` for ban-sync. No denormalised counters - `SELECT COUNT(*)` on demand is cheap at this scale. |
| `mod_notes` | schema ready | One row per private mod note attached to a user |
| `strikes` | schema ready | One row per strike with severity (1=warn, 2=timeout, 3=ban), reason, optional `expires_at` |
| `dm_reports` | schema ready | One row per `/report-dm` submission with status workflow. `mod_channel_message_id` tracks the posted mod-queue message so a later cleanup job can edit it for screenshot redaction. |
| `birthdays` | schema ready | Opt-in user → (month, day). No year stored, intentionally |
| `reaction_role_messages` | schema ready | Maps a posted message to its emoji→role config (JSON column) |
| `prompts` | schema ready | Pool of daily-prompt strings with `last_used` for rotation |
| `ban_sync_log` | implemented | Audit trail for Reddit → Discord ban mirroring |

When implementing a module, **read from and write to these existing tables** rather than introducing new schema. If a new column is genuinely needed, add it to the `SCHEMA` array in `src/core/db.ts` as an idempotent `ALTER` and bump `schema_version`.

---

## 7. Conventions for new code

These match the patterns established in the implemented code. Follow them.

- **Logging.** Plain `console.log` / `console.warn` / `console.error` with a module-prefixed tag, e.g. `console.info("[scheduler] opened %s", name)`. Container logs are captured by Docker as JSON; no logging library is used.
- **Error handling.** Don't swallow exceptions silently. If a guild/channel/role isn't found, `console.warn(...)` and return; don't crash the module. Wrap interaction handlers in try/catch and call `interaction.reply` / `editReply` with an error message rather than letting the exception bubble.
- **Permission gating.** Use `requireModerator(interaction)` / `requireFortyPlus(interaction)` from `src/core/permissions.ts` at the top of every guarded command - they reply and return `false` on failure so the command short-circuits. Don't re-implement role checks inline.
- **DB access.** Call `getDb()` from `src/core/db.ts` to get the shared `better-sqlite3` handle. Use parameterised statements (`db.prepare("... WHERE id = ?").get(id)`); never string-interpolate IDs or user-supplied text. Discord snowflakes are stored as `TEXT`, not `INTEGER`.
- **Scheduling.** Use `addJob(id, expr, tz, handler)` from `src/core/scheduling.ts`. Each job has a unique `id` so a hot-reload replaces the existing job rather than duplicating it.
- **Config.** Read your module's section from `loadSettings().yaml` (e.g. `settings.yaml.daily_prompt`). Sensitive secrets/IDs belong in `.env` (extend the `Settings` interface in `src/core/config.ts`); runtime-tweakable values belong in `config.yaml`.
- **Slash commands.** Build with `SlashCommandBuilder` from `discord.js`. Mod-only commands should call `setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)` so they're hidden from non-mods in Discord's autocomplete (the app-layer `requireModerator()` check is the actual security boundary). Use `interaction.reply({ ..., flags: MessageFlags.Ephemeral })` for mod-only responses to keep mod chatter private. For commands doing multiple async operations, `deferReply` first then `editReply`.
- **Module loading.** Each file exports a default `BotModule` (`name`, optional `commands`, optional `init`). Add its import + the module instance to the `MODULES` array in `src/bot.ts`.
- **No new dependencies without justification.** Current deps: `discord.js`, `better-sqlite3`, `croner`, `fastify`, `dotenv`, `yaml`. Anything else needs a real reason.

---

## 8. Roadmap - modules to build

Listed in recommended build order. Each entry specifies the purpose, slash command surface, DB tables, and implementation notes. Build one module at a time, test, then move to the next.

### 8.1 `src/modules/modNotes.ts` - Mod notes & strikes (IMPLEMENTED)

**Purpose:** Persistent, private record of moderator observations and disciplinary actions on users. Foundation for `dm_reports` and any future moderation feature.

**Slash commands** (all `requireModerator()`, all responses ephemeral):
- `/note add user:<user> note:<text>` - Adds a row to `mod_notes`.
- `/note view user:<user>` - Replies with all notes on the user, newest first.
- `/note remove note_id:<int>` - Deletes a specific note.
- `/strike add user:<user> severity:<1|2|3> reason:<text> [duration_days:<int>]` - Records a strike. Severity 2 (timeout) requires `duration_days` (1-28; Discord's max). Severity 3 (ban) executes immediately - there is no confirmation step (decided 2026-05-08). The Discord-side action runs first; if it fails, no strike row is recorded.
- `/strike view user:<user>` - Shows active strikes (`expires_at` null or future).
- `/history user:<user>` - Combined chronological view: notes + strikes + dm_reports where user is reporter or reported.

**Severity → Discord action / expiry:**
| Severity | Discord action | `expires_at` |
| --- | --- | --- |
| 1 (warn) | none | now + 90 days |
| 2 (timeout) | `member.timeout(durationMs)` | now + duration_days |
| 3 (ban) | `guild.bans.create(userId)` (immediate) | NULL (permanent) |

**DB tables:** `users`, `mod_notes`, `strikes`.

**Notes:**
- All actions post a structured embed to `MOD_LOG_CHANNEL_ID` (color-coded per severity) with the acting mod, target user, and details.
- `users` rows are auto-created on first action via `INSERT OR IGNORE`. `joined_at` is left NULL until/unless a `GuildMemberAdd` listener populates it.
- User parameters use `User` (not `GuildMember`) so commands work for users who have left or been banned.
- Module-level helpers (`addNote`, `addStrike`, `getHistory`, `logAction`, `ensureUser`, etc.) are exported so `dmReports` can record actions through this module rather than re-implementing the DB layer.

### 8.2 `src/modules/dmReports.ts` - DM creeper reports (IMPLEMENTED)

**Purpose:** Allow members to report unsolicited or inappropriate DMs. Mods triage from a queue posted to `MOD_LOG_CHANNEL_ID`.

**Slash command** (40+ role only):
- `/report user:<member> context:<text>` - both required. Creates a `dm_reports` row with status `'open'`. Posts the report to `MOD_LOG_CHANNEL_ID` with four action buttons and pings the moderator role.

**Decisions made (resolved 2026-05-09):**
- **Text-only reports.** No screenshot attachments. Mods can DM the reporter for further evidence if needed. Eliminates the screenshot-retention problem entirely.
- **Notify on every report**, not at a threshold. Each report is independent; mod channel pings the `mods` role for each. No counter logic, no auto-flag.
- **Field name `user:`** (not `reported_user:`) - reporter is implicit from interaction context.
- **No confirm step on Ban button** - one click bans. Per operator's preference; mods can unban if needed.

**Mod channel UI** (Discord buttons + modals):
- **Dismiss** - one click, marks `'dismissed'`, edits embed to ACTIONED, removes buttons.
- **Add Note** - opens modal with `note` text field; calls `modNotes.addNote()`; logs to mod channel; edits embed.
- **Strike** - opens modal with `severity` (1/2/3), `reason`, optional `duration_days`; applies the appropriate Discord-side action (timeout for 2, ban for 3); calls `modNotes.addStrike()`; logs to mod channel; edits embed.
- **Ban** - one click, immediate permanent ban; records as severity-3 strike for `/history`; logs; edits embed.

After any action, the original report embed is edited in place to show "ACTIONED: \<decision\> by \<mod\>" and the buttons are removed. Each action also produces a separate mod-log embed describing the note/strike/ban.

**DB tables:** `dm_reports` (the report itself), plus cross-module calls into `users`, `mod_notes`, `strikes` via `modNotes` helpers (`addNote`, `addStrike`, `ensureUser`, `logAction`). The `screenshot_url` column exists but is unused.

**Cross-module integration:** dmReports imports `modNotes` helpers directly. This is the canonical example of why `modNotes` exposes its DB helpers as exported functions rather than just slash commands.

### 8.3 `src/modules/reactionRoles.ts` - Self-assignable roles

**Purpose:** Members assign themselves roles (timezone, interests, life stage, pronouns) by reacting to bot-posted messages.

**Slash commands** (all `requireModerator()`):
- `/rr-create channel:<channel> title:<text> description:<text>` - Posts an embed. Returns the message ID.
- `/rr-add-role message_id:<str> emoji:<str> role:<role>` - Adds an emoji→role mapping to that message. Updates `reaction_role_messages.config_json`. Bot adds the reaction to the message.
- `/rr-remove-role message_id:<str> emoji:<str>` - Reverse.

**Listeners:**
- `Events.MessageReactionAdd` - if `reaction.message.id` is in `reaction_role_messages` and the emoji maps to a role, add the role to the user. Use `client.on(Events.MessageReactionAdd, ...)` and call `reaction.fetch()` first if `reaction.partial` is true so it fires for messages not in cache.
- `Events.MessageReactionRemove` - reverse.

**DB tables:** `reaction_role_messages` (config stored as JSON in `config_json`).

**Notes:**
- Ignore reactions from the bot itself (`user.id === client.user.id`).
- Requires the `GuildMessageReactions` intent.

### 8.4 `src/modules/prompts.ts` - Daily conversation prompts

**Purpose:** Posts a rotating conversation prompt to a designated channel each day.

**Slash commands** (all `requireModerator()`):
- `/prompt add text:<str> [category:<str>]`
- `/prompt remove id:<int>`
- `/prompt list [category:<str>]`
- `/prompt post-now` - fires the daily post immediately.

**Schedule:** `addJob()` cron from `config.yaml` (`features.daily_prompt.cron`, `features.daily_prompt.timezone`). On fire, picks the prompt with the oldest `last_used` (NULL counts as oldest), posts it, updates `last_used`.

**DB tables:** `prompts`.

**Notes:**
- Initial prompt seeding can be done via `/prompt add` post-deploy, or by adding seed `INSERT OR IGNORE` rows to the `SCHEMA` array in `src/core/db.ts`.

### 8.5 `src/modules/birthdays.ts` - Birthday tracking

**Purpose:** Members opt in to birthday tracking; bot announces birthdays daily.

**Slash commands:**
- `/birthday set month:<1-12> day:<1-31>` - `requireFortyPlus()`. Validates the date (handle Feb 29 → store as Feb 28 with a note, or reject and require Feb 28). Upserts into `birthdays`.
- `/birthday remove` - Deletes the user's row.
- `/birthday today` - Lists members whose birthday is today (mod or anyone - your call; default to anyone).

**Schedule:** Daily cron from `config.yaml` (`features.birthdays.cron`, `features.birthdays.timezone`). Posts to the configured announce channel.

**DB tables:** `birthdays`.

**Privacy:** Year is **never** stored. The schema enforces this.

### 8.6 `src/modules/redditSync.ts` - Reddit ↔ Discord integration (IMPLEMENTED)

**Two integrations, sharing a Devvit companion app:**

#### A. Modlog ban relay (Reddit → Discord)

When a moderator bans a user on r/FriendsOver40, the Devvit app POSTs a structured embed to a Discord webhook in a private bridge channel. This module's `MessageCreate` listener picks it up and bans the linked Discord user. Discord-side bans do NOT propagate back to Reddit. Announcement mirroring is out of scope.

A mod-only "Sync banned users to Discord" menu item on the Devvit app replays the current Reddit banned-users list as synthetic ban embeds (one per user, with `moderator = "(bulk sync)"`); the bot suppresses the no-link mod-log notification for these events to keep the bridge channel clean. Work runs in a Devvit scheduler task in the background.

#### B. Invite-link join flow (Reddit → Discord, with auto-verification)

The Devvit app provides a custom post type "Join Discord" that mods pin to r/FriendsOver40. When a logged-in Reddit user clicks the post's button:

1. The webview button POSTs `/api/join-token` on the Devvit app's own server, which reads the current Reddit user via `reddit.getCurrentUsername()` and signs an HMAC-SHA256 token containing `{u: username, e: expiry}` using `signing_secret` (shared with the bot).
2. The webview calls `navigateTo()` (from `@devvit/web/client`) to send the browser to `bot_join_url?token=...`.
3. The bot (`src/web/server.ts`, fastify) verifies the signature and expiry.
4. The bot creates a one-time-use Discord invite for `INVITE_CHANNEL_ID` (`maxUses: 1`, `maxAge: 600`) and stores `{invite_code: reddit_username}` in `pending_invites`.
5. The bot redirects the browser to `https://discord.gg/<invite_code>`.
6. The user joins Discord normally.
7. The module's `Events.GuildMemberAdd` listener compares pre/post invite-use counts to identify which invite was used, looks up `pending_invites`, saves `users.reddit_username`, and assigns the `40+` role. The pending row is then deleted.

User-facing experience: **two clicks** (the Reddit post button + Discord's "Accept invite" prompt). No slash commands, no codes, no forms. Reddit identity is auto-verified via Devvit's auth context.

**Architecture rationale:** Reddit closed the script-app API path in late 2025 in favour of Devvit. Direct PRAW / Reddit API access is no longer available, so the bot has no Reddit credentials. Devvit Web apps run sandboxed on Reddit but can POST to allowlisted external domains (`discord.com` is declared in `devvit.json`'s `permissions.http.domains`; the bot's web server's domain doesn't need allowlisting because the Devvit app navigates the user's browser there rather than fetching server-to-server).

All Devvit settings (`discord_webhook_url`, `signing_secret`, `bot_join_url`) are **installation-scoped** so multiple subreddits can install the same app and point it at their own Discord servers/bots independently.

**Slash commands** (mod-only - users don't need to do anything; auto-link happens via the join flow):
- `/link-reddit user:<user> username:<str>` - manually link a Discord user to a Reddit username (e.g. for users who joined via a different invite or whose auto-link failed).
- `/unlink-reddit user:<user>` - remove a user's link.
- `/reddit-status [user:<user>]` - show linked Reddit username (anyone for self; mods for others).

**DB tables:** `users` (the link), `ban_sync_log`, `pending_invites` (transient mapping invite_code → reddit_username, consumed on member join).

**Required env vars** (bot side, in `.env`):
- `BRIDGE_CHANNEL_ID`, `BRIDGE_WEBHOOK_ID` - bridge channel + webhook for ban relay
- `BRIDGE_SIGNING_SECRET` - shared HMAC secret with Devvit's `signing_secret`
- `BOT_PUBLIC_URL` - public URL the bot serves on (must match Devvit's `bot_join_url`)
- `WEB_SERVER_PORT` - local listen port (default 8080)
- `INVITE_CHANNEL_ID` - channel new members are invited into

The bot's web server self-disables if any of `BRIDGE_SIGNING_SECRET`, `INVITE_CHANNEL_ID`, or `BOT_PUBLIC_URL` is missing. The `MessageCreate` bridge listener self-disables if either `BRIDGE_CHANNEL_ID` or `BRIDGE_WEBHOOK_ID` is missing.

**Discord permissions the bot needs:**
- `Create Instant Invite` on the invite channel (to create one-time invites)
- `Manage Server` or `View Audit Log` on the guild (to list invites for the use-count comparison in `GuildMemberAdd`)
- `Manage Roles` (to assign the 40+ role)
- `Ban Members` (for ban relay)

The bot itself has **no Reddit credentials** and makes **no Reddit API calls**.

```
[Reddit modlog ban]
        ↓
[Devvit app's onModAction trigger endpoint fires]
        ↓
[Devvit server POSTs embed to Discord webhook URL]
        ↓
[Webhook lands message in #reddit-bridge channel]
        ↓
[Bot's MessageCreate listener picks it up, applies Discord ban]
```

**Webhook embed protocol** (set by the Devvit app, read by the bot's `MessageCreate` listener in the bridge channel):

| `embed.title` | Fields | Action |
| --- | --- | --- |
| `[fo40-bridge] ban` | `reddit_username`, `moderator`, `reason` | Look up linked Discord user; ban with reason; log to `ban_sync_log` and `MOD_LOG_CHANNEL_ID`. If unmatched, log and post a heads-up. |
| `[fo40-bridge] unban` | `reddit_username`, `moderator` | Look up linked Discord user; unban; log. |

The bot filters by both `message.channel.id === BRIDGE_CHANNEL_ID` and `message.webhookId === BRIDGE_WEBHOOK_ID`.

**Out of scope:**
- Discord-ban → Reddit-ban (outbound sync). Blast radius too high; mods can ban on Reddit manually if needed.
- Announcement-flair post mirroring. Operator does not use this workflow.

**Caveats / risks:**
- Identity verification depends on the Devvit app correctly reading `reddit.getCurrentUsername()` for the Reddit username. The signing secret prevents URL forgery, but if Reddit's auth is compromised the chain breaks at that point.
- The Discord webhook URL and the signing secret are the trust boundaries. Both must be stored only in the Devvit app's installation settings (encrypted at rest by Reddit) and the bot's `.env`.
- If `BOT_PUBLIC_URL` becomes unreachable, the join button on Reddit fails for users; they see an error message in the post. The Devvit ban relay is unaffected because it goes directly to Discord's webhook URL.
- The bot needs to keep its invite cache in sync. After a restart it rebuilds from `guild.invites.fetch()` on `ClientReady`. Anyone joining during the brief window before `ClientReady` may not get auto-linked; mods can use `/link-reddit` to fix.
- Reddit's outbound-fetch gateway throttles aggressively (limit undocumented, but bursts of more than a handful of `fetch()` calls to `discord.com` per several seconds put the app into a sustained app-wide penalty box). Mitigations in `reddit_devvit/`: bulk-sync runs as a scheduler task with batched embeds and multi-second pacing; the ban-relay trigger retries with backoff. Any new outbound-fetch flow must be similarly conservative.

---

## 9. Things explicitly out of scope

Do not build these. They have been considered and rejected:

- **AI tone / sentiment / aggression detection.** False positives feel like surveillance to a 40+ audience. Humans stay in the loop; the bot routes flags but does not act on tone.
- **Crisis-phrase auto-DM with hotlines.** A bot replying to "I'm so done" with a suicide hotline link is jarring and potentially harmful. Pin a resources channel manually instead.
- **XP, levels, leaderboards, currency, economy bots.** The audience finds them childish.
- **Ticket bot / support-thread complexity.** A simple `#mod-help` channel is sufficient for current scale.
- **Multi-guild support.** This bot serves one server. Do not abstract for reuse.
- **Auto-moderating message content** (slurs, spam patterns, etc.) - defer to Discord's built-in AutoMod feature for now.

---

## 10. Discord server setup requirements

These are operator responsibilities, but new modules may depend on them. Verify before building modules that interact with channels or roles.

1. **Bot role placement.** The `friends-bot` role exists, positioned above `@everyone` and below `mods`/`admins`. Do not grant Administrator.
2. **Per-channel permissions for the bot.** On every channel the bot manages (e.g. `#selfie-sunday`), the `friends-bot` role is explicitly granted: View Channel, Send Messages, Manage Messages, Manage Channels. Without this, hiding a channel from `@everyone` locks the bot out too.
3. **Existing role gating.** The server uses an onboarding question that assigns either `40+` or `underage`. The `40+` role is the access gate; `@everyone` has no channel access. Bot features that should require verified-age members use `requireFortyPlus(interaction)` (which checks for `40+`). The `underage` role needs no special handling - lacking `40+` is what gates access.
4. **Privileged Gateway Intents.** Server Members Intent must be enabled in the Discord Developer Portal. Message Content Intent is currently **off** and should remain off unless a future module genuinely needs to read message text.

---

## 11. Open decisions / things to confirm with operator

If you (Claude Code) hit one of these while building, surface it to the operator rather than picking arbitrarily:

- **Daily prompt seed list.** Initial prompt content is operator-provided. Don't invent prompts; ask.
- **Birthday Feb 29 handling.** Spec proposes "store as Feb 28." Could also reject. Confirm.

---

## 12. How to extend

When adding a new module:

1. Create `src/modules/<name>.ts` exporting a default `BotModule`.
2. Use `src/core/` helpers (`getDb()`, `loadSettings()`, `addJob()`, `requireModerator()` / `requireFortyPlus()`, `isModerator()` / `isAdmin()` / `isFortyPlus()`).
3. Use the appropriate existing DB tables. Only extend the `SCHEMA` array in `src/core/db.ts` if a column is genuinely missing.
4. Add the module to the `MODULES` array in `src/bot.ts`.
5. Add any new YAML config under a top-level key matching the feature (e.g. `daily_prompt:`).
6. Add new env vars to `.env.example` and to the `Settings` interface in `src/core/config.ts` if they're sensitive/operational.
7. Update this spec's roadmap section to mark the module implemented.
8. Update `README.md`'s "What it does" list.

When in doubt, match the patterns in `src/modules/scheduler.ts` and `src/core/`.
