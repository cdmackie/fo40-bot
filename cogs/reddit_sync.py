"""Reddit -> Discord ban sync via a Devvit bridge.

A companion Devvit app on r/FriendsOver40 (see `reddit_devvit/`) posts modlog
events and verification attempts to a Discord webhook. The webhook lands the
messages in a dedicated bridge channel that this cog watches via `on_message`.

The bot itself holds NO Reddit credentials and does not call any Reddit API.
Everything Reddit-side is done by the Devvit app, which Reddit hosts.

Slash commands:
  /link-reddit                — issues a one-time code; instructs user to
                                go to the Devvit form on Reddit and paste it
  /unlink-reddit              — removes the link
  /reddit-status [user:<u>]   — shows linked Reddit username (mod-only for
                                looking up another user)

Webhook embed protocol (set by the Devvit app):
  title="[fo40-bridge] ban"
    fields: reddit_username, moderator, reason
  title="[fo40-bridge] verify"
    fields: reddit_username, code

If BRIDGE_CHANNEL_ID or BRIDGE_WEBHOOK_ID is unset in .env, this cog
self-disables at load time.
"""
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands

from core import config, db
from core.permissions import forty_plus_only, is_moderator

log = logging.getLogger("fo40.reddit_sync")
settings = config.load()

CODE_TTL_SECONDS = 10 * 60  # 10 minutes

NO_PINGS = discord.AllowedMentions.none()


@dataclass
class PendingVerification:
    discord_id: int
    code: str
    created_at: float  # time.monotonic()


# In-memory pending verifications (lost on bot restart; user just runs
# /link-reddit again). One per Discord user.
_pending: dict[int, PendingVerification] = {}


def _cleanup_expired():
    now = time.monotonic()
    expired = [k for k, v in _pending.items() if now - v.created_at > CODE_TTL_SECONDS]
    for k in expired:
        _pending.pop(k, None)


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

    # ----- Slash commands -----

    @app_commands.command(
        name="link-reddit",
        description="Get a one-time code to link your Reddit account via Reddit",
    )
    @forty_plus_only()
    async def link_reddit(self, interaction: discord.Interaction):
        existing = await _get_reddit_username(interaction.user.id)
        if existing:
            await interaction.response.send_message(
                f"You're already linked to u/{existing}. "
                "Use `/unlink-reddit` first if you want to change it.",
                ephemeral=True,
            )
            return
        _cleanup_expired()
        code = f"{secrets.randbelow(1_000_000):06d}"
        _pending[interaction.user.id] = PendingVerification(
            discord_id=interaction.user.id,
            code=code,
            created_at=time.monotonic(),
        )
        await interaction.response.send_message(
            f"Your one-time code: **{code}** (valid 10 minutes).\n\n"
            "Go to **r/FriendsOver40** on Reddit, click the subreddit menu (`...`), "
            "select **Link Discord account**, and paste the code into the form.\n\n"
            "Once you submit it, your Discord account will be linked automatically.",
            ephemeral=True,
        )
        log.info(
            "verification code issued for discord=%s",
            interaction.user.id,
        )

    @app_commands.command(
        name="unlink-reddit",
        description="Remove your Reddit account link",
    )
    @forty_plus_only()
    async def unlink_reddit(self, interaction: discord.Interaction):
        existing = await _get_reddit_username(interaction.user.id)
        if not existing:
            await interaction.response.send_message(
                "You don't have a Reddit account linked.",
                ephemeral=True,
            )
            return
        await _set_reddit_username(interaction.user.id, None)
        await interaction.response.send_message(
            f"Unlinked u/{existing}.",
            ephemeral=True,
        )
        log.info("unlinked: discord=%s reddit=u/%s", interaction.user.id, existing)

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

    # ----- Bridge listener -----

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        # Diagnostic: log every message in the bridge channel regardless of
        # webhook filter, so we can see what the bot is actually receiving.
        if message.channel.id == settings.bridge_channel_id:
            log.info(
                "bridge msg seen: webhook_id=%s expected=%s match=%s embeds=%d titles=%s",
                message.webhook_id,
                settings.bridge_webhook_id,
                message.webhook_id == settings.bridge_webhook_id,
                len(message.embeds),
                [e.title for e in message.embeds],
            )
        # Only listen in the configured bridge channel, and only to messages
        # from the configured webhook (other webhooks or human messages in
        # that channel are ignored).
        if message.channel.id != settings.bridge_channel_id:
            return
        if message.webhook_id != settings.bridge_webhook_id:
            return
        for embed in message.embeds:
            title = (embed.title or "").strip()
            if title == "[fo40-bridge] ban":
                await self._handle_ban_event(embed)
            elif title == "[fo40-bridge] verify":
                await self._handle_verify_event(embed)
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

    async def _handle_verify_event(self, embed: discord.Embed):
        fields = {f.name: f.value for f in embed.fields}
        reddit_username = (fields.get("reddit_username") or "").strip()
        code = (fields.get("code") or "").strip()
        if not reddit_username or not code:
            log.warning("verify embed missing fields")
            return

        _cleanup_expired()
        # Find pending entry by code (constant-time-ish comparison via secrets).
        match: tuple[int, PendingVerification] | None = None
        for discord_id, p in _pending.items():
            if secrets.compare_digest(p.code, code):
                match = (discord_id, p)
                break
        if match is None:
            log.info(
                "verify event with unknown/expired code from u/%s",
                reddit_username,
            )
            return
        discord_id, _p = match

        # Reddit username already linked to someone else?
        existing_owner = await _get_discord_id_for_reddit(reddit_username)
        if existing_owner is not None and existing_owner != discord_id:
            log.info(
                "u/%s already linked to discord=%s; refusing to relink",
                reddit_username, existing_owner,
            )
            await self._dm_user(
                discord_id,
                f"u/{reddit_username} is already linked to a different Discord user. "
                "Linking failed.",
            )
            _pending.pop(discord_id, None)
            return

        await _set_reddit_username(discord_id, reddit_username)
        _pending.pop(discord_id, None)
        log.info("linked: discord=%s reddit=u/%s", discord_id, reddit_username)
        await self._dm_user(
            discord_id,
            f"Your Discord account is now linked to u/{reddit_username}. "
            "If they're banned on r/FriendsOver40, you'll be auto-banned here too.",
        )

    # ----- Helpers -----

    async def _dm_user(self, discord_id: int, content: str):
        try:
            user = self.bot.get_user(discord_id) or await self.bot.fetch_user(discord_id)
            await user.send(content, allowed_mentions=NO_PINGS)
        except discord.HTTPException:
            log.exception("failed to DM user %s", discord_id)

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


async def setup(bot: commands.Bot):
    if not settings.bridge_channel_id or not settings.bridge_webhook_id:
        log.info(
            "BRIDGE_CHANNEL_ID and/or BRIDGE_WEBHOOK_ID not set; reddit_sync disabled. "
            "See reddit_devvit/README.md for setup."
        )
        return
    await bot.add_cog(RedditSyncCog(bot))
