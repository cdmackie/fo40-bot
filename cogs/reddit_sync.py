"""Reddit -> Discord ban sync + invite-link auto-verification.

There are two integration paths between r/FriendsOver40 (a Devvit app) and
this bot:

  1. Ban relay (existing). The Devvit app's ModAction trigger forwards bans
     to a Discord webhook in a private bridge channel. This cog's
     `on_message` listener picks them up and applies a Discord ban to the
     linked Discord user. One-way only.

  2. Invite-link verification (new). The Devvit app pins a custom post on
     r/FriendsOver40 with a "Get Discord invite" button. The button signs an
     HMAC token containing the user's Reddit username and redirects them to
     the bot's web server (web/server.py). The web server creates a
     one-time-use Discord invite, stores {invite_code: reddit_username} in
     `pending_invites`, and redirects the browser to discord.gg/<code>. When
     the user joins Discord, this cog's `on_member_join` listener correlates
     the used invite to the pending mapping and:
       - saves the Reddit link (`users.reddit_username`)
       - assigns the 40+ role
       - DMs the user a welcome message

Slash commands:
  /link-reddit user:<user> username:<str>  — mod-only, manual link
  /unlink-reddit user:<user>               — mod-only, manual unlink
  /reddit-status [user:<user>]             — anyone for self; mod-only for others

If BRIDGE_CHANNEL_ID/BRIDGE_WEBHOOK_ID aren't set, the on_message bridge
listener self-disables. The on_member_join handler always runs (it's harmless
without invite-link mapping).
"""
import logging
import re
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands

from core import config, db
from core.permissions import is_moderator, mod_only

log = logging.getLogger("fo40.reddit_sync")
settings = config.load()

USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,20}$")

NO_PINGS = discord.AllowedMentions.none()


# ---------- DB helpers ----------

async def _get_reddit_username(discord_id: int) -> str | None:
    async with db.connect() as conn:
        async with conn.execute(
            "SELECT reddit_username FROM users WHERE discord_id = ?",
            (discord_id,),
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else None


async def _get_discord_id_for_reddit(reddit_username: str) -> int | None:
    async with db.connect() as conn:
        async with conn.execute(
            "SELECT discord_id FROM users WHERE LOWER(reddit_username) = LOWER(?)",
            (reddit_username,),
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else None


async def _set_reddit_username(discord_id: int, reddit_username: str | None):
    async with db.connect() as conn:
        await conn.execute(
            "INSERT OR IGNORE INTO users (discord_id) VALUES (?)",
            (discord_id,),
        )
        await conn.execute(
            "UPDATE users SET reddit_username = ? WHERE discord_id = ?",
            (reddit_username, discord_id),
        )
        await conn.commit()


async def _consume_pending_invite(invite_code: str) -> str | None:
    """Look up the Reddit username an invite was issued for, and clear it.
    Returns None if no pending mapping exists for this code."""
    async with db.connect() as conn:
        async with conn.execute(
            "SELECT reddit_username FROM pending_invites WHERE invite_code = ?",
            (invite_code,),
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        await conn.execute(
            "DELETE FROM pending_invites WHERE invite_code = ?",
            (invite_code,),
        )
        await conn.commit()
        return row[0]


async def _log_ban_sync(
    source: str,
    user_id: int | None,
    reddit_username: str,
    action: str,
    reason: str,
):
    async with db.connect() as conn:
        await conn.execute(
            "INSERT INTO ban_sync_log (source, user_id, reddit_username, action, reason) "
            "VALUES (?, ?, ?, ?, ?)",
            (source, user_id, reddit_username, action, reason),
        )
        await conn.commit()


# ---------- Cog ----------

class RedditSyncCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # invite_code -> uses count, used to determine which invite a new
        # member just used in on_member_join.
        self._invite_cache: dict[str, int] = {}

    async def cog_load(self):
        # Cache will be populated on on_ready (cog might load before the
        # bot is connected).
        pass

    async def _refresh_invite_cache(self):
        guild = self.bot.get_guild(settings.guild_id)
        if guild is None:
            return
        try:
            invites = await guild.invites()
        except discord.Forbidden:
            log.warning(
                "can't list invites for %s; auto-link on join will not work. "
                "Grant the bot 'Manage Server' or 'View Audit Log'.",
                guild.name,
            )
            return
        self._invite_cache = {inv.code: (inv.uses or 0) for inv in invites}
        log.info("invite cache populated: %d invites", len(self._invite_cache))

    @commands.Cog.listener()
    async def on_ready(self):
        await self._refresh_invite_cache()

    @commands.Cog.listener()
    async def on_invite_create(self, invite: discord.Invite):
        if invite.guild and invite.guild.id == settings.guild_id:
            self._invite_cache[invite.code] = invite.uses or 0

    @commands.Cog.listener()
    async def on_invite_delete(self, invite: discord.Invite):
        if invite.guild and invite.guild.id == settings.guild_id:
            self._invite_cache.pop(invite.code, None)

    # ----- Auto-link on join -----

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if member.guild.id != settings.guild_id:
            return

        used_invite = await self._identify_used_invite(member.guild)
        if used_invite is None:
            log.info(
                "member %s (%s) joined; could not determine which invite was used",
                member.id, member.name,
            )
            return

        reddit_username = await _consume_pending_invite(used_invite.code)
        if reddit_username is None:
            log.info(
                "member %s joined via invite %s; no pending Reddit mapping",
                member.id, used_invite.code,
            )
            return

        await _set_reddit_username(member.id, reddit_username)
        log.info(
            "auto-linked discord=%s to reddit=u/%s (invite %s)",
            member.id, reddit_username, used_invite.code,
        )

        # Assign 40+ role.
        role = member.guild.get_role(settings.forty_plus_role_id)
        if role is None:
            log.warning(
                "40+ role %s not found in guild; skipping role assign",
                settings.forty_plus_role_id,
            )
        else:
            try:
                await member.add_roles(
                    role, reason=f"invite-link auto-verify from u/{reddit_username}",
                )
            except discord.HTTPException:
                log.exception("failed to assign 40+ role to %s", member.id)

        # DM welcome.
        try:
            await member.send(
                f"Welcome to FriendsOver40! Your Discord account is now linked "
                f"to u/{reddit_username} and you have full access to the server.",
                allowed_mentions=NO_PINGS,
            )
        except discord.HTTPException:
            log.debug("could not DM welcome to %s (DMs likely closed)", member.id)

    async def _identify_used_invite(
        self, guild: discord.Guild,
    ) -> discord.Invite | None:
        """Return the invite whose use-count went up since the last cache, or None."""
        try:
            current = await guild.invites()
        except discord.Forbidden:
            log.warning("can't list invites in %s; auto-link disabled", guild.name)
            return None

        used: discord.Invite | None = None
        for inv in current:
            cached = self._invite_cache.get(inv.code, 0)
            if (inv.uses or 0) > cached:
                used = inv
                break

        # Refresh cache. Note: a one-use invite may have been deleted after use,
        # in which case it's not in `current` — we handle that below.
        new_cache = {inv.code: (inv.uses or 0) for inv in current}

        if used is None:
            # Invite may be a one-time-use that got deleted on use. The deleted
            # code is still in our cache but missing from `current` → that's
            # the one we want.
            for code in self._invite_cache:
                if code not in new_cache:
                    # Reconstruct a minimal Invite-like object. discord.py's
                    # Invite is complex; we just need .code so use a simple
                    # wrapper.
                    return _DeletedInvite(code=code)

        self._invite_cache = new_cache
        return used

    # ----- Slash commands -----

    @app_commands.command(
        name="link-reddit",
        description="Manually link a Discord user to a Reddit username (mods/admins only)",
    )
    @app_commands.describe(
        user="Discord user to link",
        username="Reddit username (without u/)",
    )
    @mod_only()
    async def link_reddit(
        self,
        interaction: discord.Interaction,
        user: discord.User,
        username: str,
    ):
        username = username.strip().lstrip("/").removeprefix("u/").strip()
        if not USERNAME_RE.match(username):
            await interaction.response.send_message(
                "That doesn't look like a valid Reddit username "
                "(3-20 chars; letters, digits, `-`, `_`).",
                ephemeral=True,
            )
            return

        existing_other = await _get_discord_id_for_reddit(username)
        if existing_other and existing_other != user.id:
            await interaction.response.send_message(
                f"u/{username} is already linked to another Discord user "
                f"(<@{existing_other}>).",
                ephemeral=True,
                allowed_mentions=NO_PINGS,
            )
            return

        existing_self = await _get_reddit_username(user.id)
        await _set_reddit_username(user.id, username)

        if existing_self:
            note = f" (was u/{existing_self})"
        else:
            note = ""
        await interaction.response.send_message(
            f"Linked {user.mention} to u/{username}{note}.",
            ephemeral=True,
            allowed_mentions=NO_PINGS,
        )
        log.info(
            "manual link by %s: discord=%s reddit=u/%s",
            interaction.user.id, user.id, username,
        )

    @app_commands.command(
        name="unlink-reddit",
        description="Remove a Discord user's Reddit link (mods/admins only)",
    )
    @app_commands.describe(user="Discord user to unlink")
    @mod_only()
    async def unlink_reddit(
        self,
        interaction: discord.Interaction,
        user: discord.User,
    ):
        existing = await _get_reddit_username(user.id)
        if not existing:
            await interaction.response.send_message(
                f"{user.mention} has no linked Reddit account.",
                ephemeral=True,
                allowed_mentions=NO_PINGS,
            )
            return
        await _set_reddit_username(user.id, None)
        await interaction.response.send_message(
            f"Unlinked {user.mention} from u/{existing}.",
            ephemeral=True,
            allowed_mentions=NO_PINGS,
        )
        log.info(
            "manual unlink by %s: discord=%s reddit=u/%s",
            interaction.user.id, user.id, existing,
        )

    @app_commands.command(
        name="reddit-status",
        description="Show your linked Reddit account (or another user's, mods only)",
    )
    @app_commands.describe(user="Optional: another user (mods/admins only)")
    async def reddit_status(
        self,
        interaction: discord.Interaction,
        user: discord.User | None = None,
    ):
        looking_at_other = user is not None and user.id != interaction.user.id
        if looking_at_other:
            if not isinstance(interaction.user, discord.Member) or not is_moderator(interaction.user):
                await interaction.response.send_message(
                    "Looking up another user's Reddit link is mods/admins only.",
                    ephemeral=True,
                )
                return
            target_id = user.id
            label = user.display_name
        else:
            target_id = interaction.user.id
            label = "You"

        username = await _get_reddit_username(target_id)
        if not username:
            verb = "have" if not looking_at_other else "has"
            await interaction.response.send_message(
                f"{label} {verb} no linked Reddit account.",
                ephemeral=True,
                allowed_mentions=NO_PINGS,
            )
            return
        await interaction.response.send_message(
            f"{label}: u/{username}",
            ephemeral=True,
            allowed_mentions=NO_PINGS,
        )

    # ----- Bridge listener (ban relay) -----

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if not (settings.bridge_channel_id and settings.bridge_webhook_id):
            return
        if message.channel.id != settings.bridge_channel_id:
            return
        if message.webhook_id != settings.bridge_webhook_id:
            return
        for embed in message.embeds:
            title = (embed.title or "").strip()
            if title == "[fo40-bridge] ban":
                await self._handle_ban_event(embed)
            else:
                log.warning("unknown bridge embed title: %r", title)

    async def _handle_ban_event(self, embed: discord.Embed):
        fields = {f.name: f.value for f in embed.fields}
        reddit_username = (fields.get("reddit_username") or "").strip()
        reason = (fields.get("reason") or "").strip()[:512]
        if not reddit_username:
            log.warning("ban embed missing reddit_username")
            return

        discord_id = await _get_discord_id_for_reddit(reddit_username)
        if discord_id is None:
            await _log_ban_sync(
                "reddit_modlog", None, reddit_username, "unlinked", reason,
            )
            await self._post_modlog_embed(
                title="Reddit ban — no Discord link",
                description=(
                    "Reddit banned this user, but no Discord member has linked this Reddit "
                    "account. No automatic action taken."
                ),
                color=0x95A5A6,
                reddit_username=reddit_username,
                discord_id=None,
                reason=reason,
            )
            return

        guild = self.bot.get_guild(settings.guild_id)
        if guild is None:
            log.warning("guild not in cache; can't mirror ban for u/%s", reddit_username)
            return
        try:
            await guild.ban(
                discord.Object(id=discord_id),
                reason=f"Reddit modlog: {reason}",
            )
        except discord.NotFound:
            log.info("Discord %s not in guild — skipping ban mirror", discord_id)
            await _log_ban_sync(
                "reddit_modlog", discord_id, reddit_username,
                "skipped-not-in-guild", reason,
            )
            return
        except discord.Forbidden:
            log.warning(
                "can't ban Discord %s (perms/hierarchy); flagging for manual review",
                discord_id,
            )
            await _log_ban_sync(
                "reddit_modlog", discord_id, reddit_username,
                "failed-forbidden", reason,
            )
            await self._post_modlog_embed(
                title="Reddit ban — could not mirror",
                description=(
                    "Reddit banned this user, but the bot couldn't ban them on Discord "
                    "(missing permission or role hierarchy). Manual action needed."
                ),
                color=0xE67E22,
                reddit_username=reddit_username,
                discord_id=discord_id,
                reason=reason,
            )
            return

        await _log_ban_sync(
            "reddit_modlog", discord_id, reddit_username, "ban", reason,
        )
        log.info("mirrored Reddit ban: u/%s -> Discord %s", reddit_username, discord_id)
        await self._post_modlog_embed(
            title="Reddit ban mirrored",
            description="Discord ban applied automatically.",
            color=0xE74C3C,
            reddit_username=reddit_username,
            discord_id=discord_id,
            reason=reason,
        )

    async def _post_modlog_embed(
        self,
        *,
        title: str,
        description: str,
        color: int,
        reddit_username: str,
        discord_id: int | None,
        reason: str,
    ):
        channel = self.bot.get_channel(settings.mod_log_channel_id)
        if channel is None:
            log.warning("mod-log channel %s not in cache", settings.mod_log_channel_id)
            return
        embed = discord.Embed(
            title=title,
            description=description,
            color=color,
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(name="Reddit user", value=f"u/{reddit_username}", inline=True)
        if discord_id is not None:
            embed.add_field(name="Discord", value=f"<@{discord_id}>", inline=True)
        embed.add_field(name="Reason", value=reason or "(no reason)", inline=False)
        try:
            await channel.send(embed=embed, allowed_mentions=NO_PINGS)
        except discord.HTTPException:
            log.exception("failed to post modlog embed")


class _DeletedInvite:
    """Minimal stand-in for a discord.Invite when we only know the code
    (because the invite was a one-use that got deleted upon consumption)."""
    __slots__ = ("code",)

    def __init__(self, code: str):
        self.code = code


async def setup(bot: commands.Bot):
    await bot.add_cog(RedditSyncCog(bot))
