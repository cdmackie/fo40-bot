import asyncio
import logging
import time

import discord
from discord import app_commands
from discord.ext import commands

from core import config, db
from core.scheduling import get_scheduler
from web import server as web_server


settings = config.load()

# If we see this many gateway disconnects within the window, assume a doomed
# reconnect loop (e.g. session-invalidation cycle) and exit so we don't keep
# hammering Discord and deepening any rate-limit ban. Operator must restart
# manually after investigating.
DISCONNECT_THRESHOLD = 5
DISCONNECT_WINDOW_SECS = 300

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("fo40")


# Add new cogs here as you build them.
INITIAL_COGS = [
    "cogs.scheduler",
    "cogs.mod_notes",
    # "cogs.dm_reports",
    # "cogs.reaction_roles",
    # "cogs.prompts",
    # "cogs.birthdays",
    "cogs.reddit_sync",   # self-disables if Reddit creds aren't set in .env
]


class FO40Bot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.members = True            # role checks, joins
        intents.message_content = False   # flip on if a future cog needs it
        # message_content is off, so prefix commands cannot read text. Use
        # mention-as-prefix as a no-op fallback; all real commands are slash.
        super().__init__(command_prefix=commands.when_mentioned, intents=intents)
        self._disconnect_times: list[float] = []
        self._web_runner = None

    async def setup_hook(self):
        await db.init_db()
        for cog in INITIAL_COGS:
            await self.load_extension(cog)
            log.info("Loaded %s", cog)
        self.tree.on_error = _on_app_command_error
        get_scheduler().start()
        self._web_runner = await web_server.start(self)
        # Sync slash commands to the guild for instant availability.
        # Commands default to global scope (~1hr Discord propagation), so copy
        # them into the guild's namespace first; then the guild sync pushes them
        # immediately.
        guild = discord.Object(id=settings.guild_id)
        self.tree.copy_global_to(guild=guild)
        await self.tree.sync(guild=guild)

    async def on_ready(self):
        log.info("Logged in as %s (%s)", self.user, self.user.id)

    async def on_resumed(self):
        log.info("gateway session resumed")

    async def on_disconnect(self):
        # Don't count disconnects during a planned shutdown.
        if self.is_closed():
            return
        now = time.monotonic()
        self._disconnect_times = [
            t for t in self._disconnect_times
            if now - t < DISCONNECT_WINDOW_SECS
        ]
        self._disconnect_times.append(now)
        log.warning(
            "gateway disconnect (%d in last %ds)",
            len(self._disconnect_times), DISCONNECT_WINDOW_SECS,
        )
        if len(self._disconnect_times) >= DISCONNECT_THRESHOLD:
            log.error(
                "%d disconnects in %ds — doomed reconnect loop suspected. "
                "Shutting down to prevent rate-limit damage. "
                "Wait at least 10 minutes and investigate before restarting.",
                len(self._disconnect_times), DISCONNECT_WINDOW_SECS,
            )
            await self.close()

    async def close(self):
        if self._web_runner is not None:
            try:
                await self._web_runner.cleanup()
            except Exception:
                log.exception("web server cleanup failed")
        sched = get_scheduler()
        if sched.running:
            sched.shutdown(wait=False)
        await super().close()


async def _on_app_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
):
    """Send a clean ephemeral message for permission failures; log everything else."""
    if isinstance(error, app_commands.CheckFailure):
        msg = str(error) or "Permission denied."
        try:
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)
        except discord.HTTPException:
            log.exception("failed to send check-failure response")
        return
    log.exception("app command error", exc_info=error)


async def main():
    bot = FO40Bot()
    async with bot:
        await bot.start(settings.discord_token)


if __name__ == "__main__":
    asyncio.run(main())
