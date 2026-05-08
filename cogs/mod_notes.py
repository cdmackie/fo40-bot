"""Mod notes & strikes — `/note`, `/strike`, `/history` slash commands.

Module-level helpers (`add_note`, `add_strike`, `get_history`, etc.) are exposed
so that other cogs (notably `dm_reports`) can record mod actions without
re-implementing the DB plumbing.
"""
import logging
from datetime import datetime, timedelta, timezone

import aiosqlite
import discord
from discord import app_commands
from discord.ext import commands

from core import config, db
from core.permissions import mod_only

log = logging.getLogger("fo40.mod_notes")
settings = config.load()

# Severity-1 (warn) records auto-expire after this many days.
WARN_EXPIRY_DAYS = 90
# Discord caps member timeouts at 28 days.
MAX_TIMEOUT_DAYS = 28

NO_PINGS = discord.AllowedMentions.none()


# ---------- Module-level helpers (importable) ----------

async def ensure_user(user_id: int) -> None:
    """Idempotent: create a `users` row for the given Discord ID if missing."""
    async with db.connect() as conn:
        await conn.execute(
            "INSERT OR IGNORE INTO users (discord_id) VALUES (?)",
            (user_id,),
        )
        await conn.commit()


async def add_note(user_id: int, mod_id: int, note: str) -> int:
    await ensure_user(user_id)
    async with db.connect() as conn:
        cursor = await conn.execute(
            "INSERT INTO mod_notes (user_id, mod_id, note) VALUES (?, ?, ?)",
            (user_id, mod_id, note),
        )
        await conn.commit()
        return cursor.lastrowid


async def remove_note(note_id: int) -> dict | None:
    """Delete a note. Returns the original row content or None if not found."""
    async with db.connect() as conn:
        async with conn.execute(
            "SELECT user_id, mod_id, note FROM mod_notes WHERE id = ?",
            (note_id,),
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        await conn.execute("DELETE FROM mod_notes WHERE id = ?", (note_id,))
        await conn.commit()
        return {"user_id": row[0], "mod_id": row[1], "note": row[2]}


async def get_notes(user_id: int) -> list[dict]:
    async with db.connect() as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            "SELECT id, mod_id, note, created_at FROM mod_notes "
            "WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def add_strike(
    user_id: int,
    mod_id: int,
    severity: int,
    reason: str,
    duration_days: int | None = None,
) -> tuple[int, datetime | None]:
    """Insert a strike. Returns (id, expires_at).

    Severity 1: expires_at = now + 90 days.
    Severity 2: expires_at = now + duration_days (caller must pass).
    Severity 3: expires_at = NULL (permanent record; the Discord ban itself is permanent).
    """
    await ensure_user(user_id)
    now = datetime.now(timezone.utc)
    if severity == 1:
        expires_at = now + timedelta(days=WARN_EXPIRY_DAYS)
    elif severity == 2 and duration_days is not None:
        expires_at = now + timedelta(days=duration_days)
    else:
        expires_at = None
    async with db.connect() as conn:
        cursor = await conn.execute(
            "INSERT INTO strikes (user_id, mod_id, severity, reason, expires_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                user_id,
                mod_id,
                severity,
                reason,
                expires_at.isoformat() if expires_at else None,
            ),
        )
        await conn.commit()
        return cursor.lastrowid, expires_at


async def get_active_strikes(user_id: int) -> list[dict]:
    async with db.connect() as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            "SELECT id, mod_id, severity, reason, created_at, expires_at "
            "FROM strikes WHERE user_id = ? "
            "AND (expires_at IS NULL OR expires_at > datetime('now')) "
            "ORDER BY created_at DESC",
            (user_id,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def get_history(user_id: int) -> list[dict]:
    """Combined chronological history: notes, strikes, and dm_reports
    in which the user appears as either reporter or reported."""
    async with db.connect() as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT 'note' AS kind, id, created_at, mod_id AS actor_id,
                   note AS detail, NULL AS severity, NULL AS status
            FROM mod_notes WHERE user_id = ?
            UNION ALL
            SELECT 'strike' AS kind, id, created_at, mod_id AS actor_id,
                   reason AS detail, severity, NULL AS status
            FROM strikes WHERE user_id = ?
            UNION ALL
            SELECT 'reported' AS kind, id, created_at,
                   reporter_id AS actor_id,
                   COALESCE(context, '') AS detail,
                   NULL AS severity, status
            FROM dm_reports WHERE reported_user_id = ?
            UNION ALL
            SELECT 'reporter' AS kind, id, created_at,
                   reported_user_id AS actor_id,
                   COALESCE(context, '') AS detail,
                   NULL AS severity, status
            FROM dm_reports WHERE reporter_id = ?
            ORDER BY created_at DESC
            """,
            (user_id, user_id, user_id, user_id),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def log_action(bot: commands.Bot, embed: discord.Embed) -> None:
    """Post a moderation-action embed to the configured mod-log channel."""
    channel = bot.get_channel(settings.mod_log_channel_id)
    if channel is None:
        log.warning("mod-log channel %s not in cache", settings.mod_log_channel_id)
        return
    try:
        await channel.send(embed=embed, allowed_mentions=NO_PINGS)
    except discord.HTTPException:
        log.exception("failed to post mod-log embed")


# ---------- Slash command surface ----------

def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _ts(iso: str) -> int:
    """Convert an ISO-8601 string from SQLite into a Unix timestamp."""
    # SQLite's CURRENT_TIMESTAMP yields naive UTC strings like "2026-05-08 12:34:56".
    # ISO-format strings from our own writes look like "2026-05-08T12:34:56+00:00".
    # fromisoformat handles both forms in 3.11+; assume UTC if naive.
    dt = datetime.fromisoformat(iso.replace(" ", "T"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


class ModNotesCog(commands.Cog):
    note = app_commands.Group(name="note", description="Private mod notes on users")
    strike = app_commands.Group(name="strike", description="User strikes (warn / timeout / ban)")

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ----- /note -----

    @note.command(name="add", description="Add a private mod note on a user")
    @app_commands.describe(user="Member to note", note="The note text")
    @mod_only()
    async def note_add(
        self,
        interaction: discord.Interaction,
        user: discord.User,
        note: str,
    ):
        note_id = await add_note(user.id, interaction.user.id, note)
        await interaction.response.send_message(
            f"Note #{note_id} added on {user.mention}.",
            ephemeral=True,
            allowed_mentions=NO_PINGS,
        )
        embed = discord.Embed(
            title="Note added",
            color=0x3498DB,
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(name="User", value=f"{user.mention} (`{user.id}`)", inline=False)
        embed.add_field(name="Mod", value=interaction.user.mention, inline=True)
        embed.add_field(name="Note ID", value=str(note_id), inline=True)
        embed.add_field(name="Note", value=_truncate(note, 1024), inline=False)
        await log_action(self.bot, embed)

    @note.command(name="view", description="View all notes on a user")
    @app_commands.describe(user="Member to view notes for")
    @mod_only()
    async def note_view(
        self,
        interaction: discord.Interaction,
        user: discord.User,
    ):
        notes = await get_notes(user.id)
        if not notes:
            await interaction.response.send_message(
                f"No notes on {user.mention}.",
                ephemeral=True,
                allowed_mentions=NO_PINGS,
            )
            return
        lines = [
            f"**#{n['id']}** [<t:{_ts(n['created_at'])}:f>] "
            f"by <@{n['mod_id']}>: {n['note']}"
            for n in notes
        ]
        desc = _truncate("\n".join(lines), 4000)
        embed = discord.Embed(
            title=f"Notes on {user.display_name} ({len(notes)})",
            description=desc,
            color=0x3498DB,
        )
        await interaction.response.send_message(
            embed=embed, ephemeral=True, allowed_mentions=NO_PINGS,
        )

    @note.command(name="remove", description="Delete a note by its ID")
    @app_commands.describe(note_id="The note ID (shown in /note view output)")
    @mod_only()
    async def note_remove(
        self,
        interaction: discord.Interaction,
        note_id: int,
    ):
        deleted = await remove_note(note_id)
        if deleted is None:
            await interaction.response.send_message(
                f"Note #{note_id} not found.",
                ephemeral=True,
            )
            return
        await interaction.response.send_message(
            f"Note #{note_id} deleted.",
            ephemeral=True,
        )
        embed = discord.Embed(
            title="Note removed",
            color=0x95A5A6,
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(name="User", value=f"<@{deleted['user_id']}>", inline=False)
        embed.add_field(name="Removed by", value=interaction.user.mention, inline=True)
        embed.add_field(name="Note ID", value=str(note_id), inline=True)
        embed.add_field(
            name="Original text", value=_truncate(deleted["note"], 1024), inline=False,
        )
        await log_action(self.bot, embed)

    # ----- /strike -----

    @strike.command(name="add", description="Record a strike on a user")
    @app_commands.describe(
        user="Member to strike",
        severity="1 = warning, 2 = timeout, 3 = ban (immediate)",
        reason="Reason for the strike",
        duration_days="For severity 2: timeout days (1-28)",
    )
    @app_commands.choices(severity=[
        app_commands.Choice(name="1 — Warning", value=1),
        app_commands.Choice(name="2 — Timeout", value=2),
        app_commands.Choice(name="3 — Ban", value=3),
    ])
    @mod_only()
    async def strike_add(
        self,
        interaction: discord.Interaction,
        user: discord.User,
        severity: app_commands.Choice[int],
        reason: str,
        duration_days: int | None = None,
    ):
        sev = severity.value

        if sev == 2:
            if duration_days is None:
                await interaction.response.send_message(
                    "Severity-2 (timeout) needs `duration_days` (1-28).",
                    ephemeral=True,
                )
                return
            if duration_days < 1 or duration_days > MAX_TIMEOUT_DAYS:
                await interaction.response.send_message(
                    f"`duration_days` must be 1-{MAX_TIMEOUT_DAYS} (Discord's max).",
                    ephemeral=True,
                )
                return

        await interaction.response.defer(ephemeral=True)

        action_taken = "none"
        action_error: str | None = None

        # Apply Discord-side action FIRST so a failure doesn't leave a stale strike row.
        if sev == 2:
            member = interaction.guild.get_member(user.id) if interaction.guild else None
            if member is None:
                await interaction.followup.send(
                    f"{user.mention} isn't currently in the server — can't apply timeout. "
                    "No strike recorded.",
                    ephemeral=True,
                    allowed_mentions=NO_PINGS,
                )
                return
            try:
                await member.timeout(
                    timedelta(days=duration_days),
                    reason=f"Strike sev=2 by {interaction.user}: {reason}",
                )
                action_taken = f"timeout {duration_days}d"
            except discord.Forbidden:
                action_error = "Discord rejected the timeout (role hierarchy or permissions)"
            except discord.HTTPException as e:
                action_error = f"Discord error: {e}"
        elif sev == 3:
            try:
                await interaction.guild.ban(
                    user,
                    reason=f"Strike sev=3 by {interaction.user}: {reason}",
                )
                action_taken = "banned"
            except discord.Forbidden:
                action_error = "Discord rejected the ban (role hierarchy or permissions)"
            except discord.HTTPException as e:
                action_error = f"Discord error: {e}"

        if action_error:
            await interaction.followup.send(
                f"{action_error}. No strike recorded.",
                ephemeral=True,
            )
            return

        strike_id, expires_at = await add_strike(
            user.id, interaction.user.id, sev, reason, duration_days
        )

        await interaction.followup.send(
            f"Strike #{strike_id} (sev {sev}) recorded on {user.mention}. Action: {action_taken}.",
            ephemeral=True,
            allowed_mentions=NO_PINGS,
        )

        color = {1: 0xF1C40F, 2: 0xE67E22, 3: 0xE74C3C}[sev]
        embed = discord.Embed(
            title=f"Strike sev {sev} added",
            color=color,
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(name="User", value=f"{user.mention} (`{user.id}`)", inline=False)
        embed.add_field(name="Mod", value=interaction.user.mention, inline=True)
        embed.add_field(name="Strike ID", value=str(strike_id), inline=True)
        embed.add_field(name="Discord action", value=action_taken, inline=True)
        embed.add_field(name="Reason", value=_truncate(reason, 1024), inline=False)
        if expires_at:
            embed.add_field(
                name="Expires",
                value=f"<t:{int(expires_at.timestamp())}:f>",
                inline=False,
            )
        await log_action(self.bot, embed)

    @strike.command(name="view", description="View active strikes on a user")
    @app_commands.describe(user="Member to view strikes for")
    @mod_only()
    async def strike_view(
        self,
        interaction: discord.Interaction,
        user: discord.User,
    ):
        strikes = await get_active_strikes(user.id)
        if not strikes:
            await interaction.response.send_message(
                f"No active strikes on {user.mention}.",
                ephemeral=True,
                allowed_mentions=NO_PINGS,
            )
            return
        lines = []
        for s in strikes:
            exp = ""
            if s["expires_at"]:
                exp = f" (expires <t:{_ts(s['expires_at'])}:R>)"
            reason = s["reason"] or "(no reason)"
            lines.append(
                f"**#{s['id']}** sev {s['severity']} [<t:{_ts(s['created_at'])}:f>] "
                f"by <@{s['mod_id']}>: {reason}{exp}"
            )
        desc = _truncate("\n".join(lines), 4000)
        embed = discord.Embed(
            title=f"Active strikes on {user.display_name} ({len(strikes)})",
            description=desc,
            color=0xE67E22,
        )
        await interaction.response.send_message(
            embed=embed, ephemeral=True, allowed_mentions=NO_PINGS,
        )

    # ----- /history -----

    @app_commands.command(name="history", description="Combined moderation history for a user")
    @app_commands.describe(user="Member to view history for")
    @mod_only()
    async def history(
        self,
        interaction: discord.Interaction,
        user: discord.User,
    ):
        rows = await get_history(user.id)
        if not rows:
            await interaction.response.send_message(
                f"No history for {user.mention}.",
                ephemeral=True,
                allowed_mentions=NO_PINGS,
            )
            return
        lines = []
        for r in rows:
            ts = _ts(r["created_at"])
            kind = r["kind"]
            if kind == "note":
                lines.append(
                    f"`NOTE` <t:{ts}:d> #{r['id']} by <@{r['actor_id']}>: {r['detail']}"
                )
            elif kind == "strike":
                lines.append(
                    f"`STRIKE sev{r['severity']}` <t:{ts}:d> #{r['id']} "
                    f"by <@{r['actor_id']}>: {r['detail']}"
                )
            elif kind == "reported":
                lines.append(
                    f"`REPORTED ({r['status']})` <t:{ts}:d> #{r['id']} "
                    f"by <@{r['actor_id']}>: {r['detail']}"
                )
            elif kind == "reporter":
                lines.append(
                    f"`REPORTER ({r['status']})` <t:{ts}:d> #{r['id']} "
                    f"target <@{r['actor_id']}>: {r['detail']}"
                )
        desc = _truncate("\n".join(lines), 4000)
        embed = discord.Embed(
            title=f"History — {user.display_name}",
            description=desc,
            color=0x9B59B6,
        )
        await interaction.response.send_message(
            embed=embed, ephemeral=True, allowed_mentions=NO_PINGS,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModNotesCog(bot))
