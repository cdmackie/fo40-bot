# FriendsOver40 Discord Bot - Claude Code instructions

This file is loaded automatically when working in this repo. For long-form design rationale see [`SPEC.md`](SPEC.md); for setup see [`README.md`](README.md).

## What this project is

Self-hosted, single-guild TypeScript Discord bot for the r/FriendsOver40 community. Companion Devvit app at [`reddit_devvit/`](reddit_devvit/) handles Reddit-side integration. One Node process runs both the gateway connection and the HTTP `/join` endpoint, packaged in one Docker container behind nginx + Cloudflare.

## Common commands

```bash
npm run typecheck         # tsc --noEmit; run before committing
npm run build             # tsc -p .  (writes to dist/)
npm run dev               # tsx watch src/index.ts (no build step, hot-reload)

# Production deploy on the host:
cd /opt/fo40-bot
git pull
docker compose up -d --build
docker compose logs -f
```

For the Devvit app:

```bash
cd reddit_devvit
npx devvit playtest <test-sub>   # iterate on a sandbox sub <200 subscribers
npx devvit publish               # submit to Reddit's review queue (~1-2 days)
```

## Code conventions

- **TypeScript strict mode**, ES2022 modules.
- **One module per feature** in `src/modules/<name>.ts`. Each exports a default `BotModule` with `commands` (slash command definitions) and/or `init` (event listener registration). `src/bot.ts` collects them.
- **Slash commands use `SlashCommandBuilder`**. Mod-only commands set `setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)` so non-mods don't see them in autocomplete.
- **Permissions** are checked at the app layer via `requireModerator()` / `requireFortyPlus()` from `src/core/permissions.ts`. Don't trust Discord-side perm filters as the security boundary.
- **DB access** goes through `src/core/db.ts`'s `getDb()`. Schema is idempotent CREATE TABLE statements. **Discord IDs (snowflakes) are stored as TEXT, not INTEGER** - they exceed JS Number precision.
- **Scheduling** uses `addJob()` from `src/core/scheduling.ts` (croner under the hood). Each job has a unique ID for `replace_existing`-style behaviour on hot reload.
- **YAML config** is parsed with `intAsBigInt: true` then normalised; ID fields are converted to strings via `asString()` in `src/core/config.ts`. Never expose BigInts to module code.
- **Defer interactions** that do >1 async operation: `interaction.deferReply({flags: MessageFlags.Ephemeral})` then `editReply()`. Slash command handlers and modal submit handlers especially.
- **No em dashes** (`—`) anywhere - in code comments, docs, log messages, or commit messages. Use a hyphen with spaces (` - `) instead. The user is sensitive to this as an AI-tell.
- **No emojis** unless explicitly requested in user-facing strings or commit messages.

## Architecture must-knows

1. **Reddit→Discord ban sync is one-way only.** Discord-side bans do not propagate to Reddit. Don't add the reverse.
2. **`v0.1-python` tag preserves the pre-rewrite Python codebase.** Don't delete the tag.
3. **DM reports are text-only.** Adding screenshot attachments was deliberately rejected (Discord CDN URLs don't truly delete; mods DM reporters for evidence).
4. **Reports notify mods on every submission**, not at a threshold. Don't add an auto-flag counter.
5. **Reddit emits each modaction 4-8x.** Two layers of dedup defend against this:
   - Devvit-side via `redis.hSetNX` keyed on `{action, target, actionedAt}` (atomic, 10-min TTL)
   - Bot-side via in-memory `Map<key, expiry>` keyed on `${action}:${redditUsername}` (60s TTL)
   - Plus: `interaction.id` guard in `src/bot.ts` for slash commands
   Don't remove these without understanding why all three exist.
6. **The reason field for ban events is fetched separately via `subreddit.getModerationLog()`** - the `ModAction` trigger event itself doesn't include `description`/`details` for `banuser` actions.
7. **Auto-link on join uses `pending_invites` table as source of truth**, not the gateway invite cache (which has race conditions with `INVITE_DELETE` events).

## What's intentionally NOT in this bot

(see SPEC §9 for the full list and reasoning - audience is 40+ friendship community)

- AI tone / sentiment / aggression detection
- Crisis-phrase auto-DM with hotlines
- XP, levels, leaderboards, currency, economy
- Ticket/support-thread complexity
- Multi-guild support (this is hardcoded single-guild)
- Auto-moderating message content (defer to Discord's AutoMod)

## Adding a new module

1. Create `src/modules/<name>.ts` exporting a default `BotModule`.
2. Use existing helpers in `src/core/` and `src/modules/modNotes.ts` (which exports `addNote`, `addStrike`, `ensureUser`, `logAction` for cross-module use). Don't reimplement DB plumbing.
3. Use existing DB tables - the schema in `core/db.ts` covers all planned features. Only ALTER if a new column is genuinely missing.
4. Register in `src/bot.ts`'s `MODULES` array.
5. Update SPEC §8 to mark IMPLEMENTED, refresh README's "what it does" list.

## Doc files

- `README.md` - operator-facing setup
- `SPEC.md` - source of truth for what is and isn't built and why
- `reddit_devvit/README.md` - Devvit-specific setup
- `reddit_devvit/{PRIVACY,TERMS}.md` - required by Reddit App Review for HTTP-fetch apps

## Git workflow

- Default branch is `main`.
- Tag `v0.1-python` preserves the pre-rewrite Python codebase. Don't delete.
- Commit messages: imperative, focus on the *why*. No em dashes. No `🤖 Generated with...` / `Co-Authored-By: Claude` attribution lines.
- After a feature lands: update SPEC.md and README.md in the same commit if relevant.
