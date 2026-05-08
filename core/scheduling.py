import zoneinfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger


_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler:
    """Returns the shared scheduler instance, creating it on first call."""
    global _scheduler
    if _scheduler is None:
        _scheduler = AsyncIOScheduler()
    return _scheduler


def cron_trigger(expr: str, tz: str) -> CronTrigger:
    """Build a CronTrigger from a standard 5-field cron expression and tz name."""
    try:
        zone = zoneinfo.ZoneInfo(tz)
    except zoneinfo.ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone {tz!r}") from exc
    try:
        return CronTrigger.from_crontab(expr, timezone=zone)
    except ValueError as exc:
        raise ValueError(f"Invalid cron expression {expr!r}: {exc}") from exc
