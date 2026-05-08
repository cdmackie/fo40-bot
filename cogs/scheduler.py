import asyncio
import logging

import discord
from discord.ext import commands

from core import config
from core.scheduling import get_scheduler, cron_trigger

log = logging.getLogger("fo40.scheduler")


class ScheduledChannel:
    """One configured channel with open/close/purge behaviour."""

    def __init__(self, bot: commands.Bot, cfg: dict):
        self.bot = bot
        self.cfg = cfg
        self.name = cfg["name"]
        self.channel_id = cfg["channel_id"]
        self.tz = cfg["timezone"]

    def _guild(self) -> discord.Guild | None:
        return self.bot.get_guild(config.load().guild_id)

    def _target_role(self, guild: discord.Guild) -> discord.Role:
        """The role whose channel access is toggled on open/close.

        Defaults to @everyone (the spec's original behaviour). For servers
        where access is gated through a different role (e.g. `40+`), set
        `gate_role_id` on the scheduled-channel entry.
        """
        role_id = self.cfg.get("gate_role_id")
        if role_id:
            role = guild.get_role(role_id)
            if role is not None:
                return role
            log.warning(
                "[%s] gate_role_id %s not found; falling back to @everyone",
                self.name, role_id,
            )
        return guild.default_role

    async def open(self):
        guild = self._guild()
        if guild is None:
            log.warning("[%s] guild not in cache; skipping open", self.name)
            return
        channel = guild.get_channel(self.channel_id)
        if channel is None:
            log.warning("[%s] channel %s not found; skipping open",
                        self.name, self.channel_id)
            return

        target = self._target_role(guild)
        ow = channel.overwrites_for(target)
        ow.view_channel = True
        ow.send_messages = True
        ow.read_message_history = True
        await channel.set_permissions(
            target, overwrite=ow, reason=f"{self.name} opens"
        )

        announce = self.cfg.get("announce") or {}
        ann_id = announce.get("channel_id")
        ann_msg = announce.get("open_message")
        if ann_id and ann_msg:
            ann = guild.get_channel(ann_id)
            if ann:
                await ann.send(ann_msg)

        log.info("[%s] opened (gate=%s)", self.name, target.name)

    async def warn_close(self):
        """Fires `close_warning_minutes` before close.

        Posts the in-channel warning to the scheduled channel and, separately,
        the `close_message` to the announce channel. Either or both may be
        configured; if neither is set, this job isn't registered.
        """
        announce = self.cfg.get("announce") or {}
        in_channel_msg = announce.get("close_warning_message")
        announce_msg = announce.get("close_message")
        if not in_channel_msg and not announce_msg:
            return

        guild = self._guild()
        if guild is None:
            return

        if in_channel_msg:
            channel = guild.get_channel(self.channel_id)
            if channel is None:
                log.warning("[%s] channel %s not found; skipping in-channel warn",
                            self.name, self.channel_id)
            else:
                await channel.send(in_channel_msg)
                log.info("[%s] in-channel close warning posted", self.name)

        if announce_msg:
            ann_id = announce.get("channel_id")
            if not ann_id:
                log.warning("[%s] close_message set but no announce.channel_id",
                            self.name)
            else:
                ann = guild.get_channel(ann_id)
                if ann is None:
                    log.warning("[%s] announce channel %s not found",
                                self.name, ann_id)
                else:
                    await ann.send(announce_msg)
                    log.info("[%s] close announcement posted", self.name)

    async def close(self):
        guild = self._guild()
        if guild is None:
            log.warning("[%s] guild not in cache; skipping close", self.name)
            return
        channel = guild.get_channel(self.channel_id)
        if channel is None:
            log.warning("[%s] channel %s not found; skipping close",
                        self.name, self.channel_id)
            return

        target = self._target_role(guild)

        # Hide the channel first so users don't watch deletion happen.
        ow = channel.overwrites_for(target)
        ow.view_channel = False
        ow.send_messages = False
        await channel.set_permissions(
            target, overwrite=ow, reason=f"{self.name} closes"
        )

        if self.cfg.get("purge_on_close"):
            await asyncio.sleep(2)
            skip_pinned = self.cfg.get("skip_pinned", True)
            check = (lambda m: not m.pinned) if skip_pinned else None
            deleted = await channel.purge(limit=None, check=check, bulk=True)
            log.info("[%s] purged %d messages", self.name, len(deleted))

        log.info("[%s] closed (gate=%s)", self.name, target.name)


def _shift_cron(expr: str, minutes_delta: int) -> str | None:
    """
    Naive shift of a 5-field cron's minute/hour by `minutes_delta`.
    Only handles simple numeric minute and hour fields. Returns None if the
    expression is too complex to shift safely.

    Handles the case of crossing midnight backwards by decrementing dow if it's
    a single digit (the FO40 case: warn 30min before Mon 00:00 -> Sun 23:30).
    """
    parts = expr.split()
    if len(parts) != 5:
        return None
    minute, hour, dom, month, dow = parts
    try:
        m = int(minute)
        h = int(hour)
    except ValueError:
        return None

    raw_total = h * 60 + m + minutes_delta
    crossed_back = raw_total < 0
    crossed_fwd = raw_total >= 24 * 60
    total = raw_total % (24 * 60)
    new_h, new_m = divmod(total, 60)

    new_dow = dow
    if crossed_back or crossed_fwd:
        if dow.isdigit():
            delta = -1 if crossed_back else 1
            new_dow = str((int(dow) + delta) % 7)
        elif dow == "*":
            # Every day — no shift needed.
            pass
        else:
            # Complex dow expression (e.g. "1-5") — don't try to shift.
            return None

    return f"{new_m} {new_h} {dom} {month} {new_dow}"


class SchedulerCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.channels: list[ScheduledChannel] = []

    async def cog_load(self):
        scheduler = get_scheduler()
        yaml_cfg = config.load().yaml_data
        entries = yaml_cfg.get("scheduled_channels", []) or []

        for entry in entries:
            sc = ScheduledChannel(self.bot, entry)
            self.channels.append(sc)

            scheduler.add_job(
                sc.open,
                cron_trigger(entry["open_cron"], entry["timezone"]),
                id=f"{sc.name}:open",
                replace_existing=True,
            )
            scheduler.add_job(
                sc.close,
                cron_trigger(entry["close_cron"], entry["timezone"]),
                id=f"{sc.name}:close",
                replace_existing=True,
            )

            announce = entry.get("announce") or {}
            warn_min = announce.get("close_warning_minutes")
            has_warn_msg = announce.get("close_warning_message") or announce.get("close_message")
            if warn_min and has_warn_msg:
                warn_cron = _shift_cron(entry["close_cron"], -warn_min)
                if warn_cron:
                    scheduler.add_job(
                        sc.warn_close,
                        cron_trigger(warn_cron, entry["timezone"]),
                        id=f"{sc.name}:warn",
                        replace_existing=True,
                    )
                else:
                    log.warning(
                        "[%s] could not derive warn cron from %s; "
                        "set close_warning_cron explicitly if you need it",
                        sc.name, entry["close_cron"]
                    )

            log.info("Registered scheduled channel: %s", sc.name)


async def setup(bot: commands.Bot):
    await bot.add_cog(SchedulerCog(bot))
