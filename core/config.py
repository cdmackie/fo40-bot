import os
from dataclasses import dataclass
from pathlib import Path

import yaml
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Settings:
    discord_token: str
    guild_id: int
    mod_log_channel_id: int
    forty_plus_role_id: int
    moderator_role_id: int
    admin_role_id: int
    timezone: str
    log_level: str
    yaml_data: dict
    # Reddit-bridge architecture: a Devvit app posts to a Discord webhook in
    # a dedicated bridge channel. Both IDs are optional; if either is unset,
    # cogs.reddit_sync's on_message bridge listener disables itself.
    bridge_channel_id: int | None
    bridge_webhook_id: int | None
    # Invite-link flow (Devvit custom post -> signed token -> bot web server
    # -> one-time Discord invite -> auto-link on join). All four are
    # required to enable the flow; if any is missing the web server is
    # not started and on_member_join falls back to manual /link-reddit only.
    bridge_signing_secret: str | None
    web_server_port: int
    invite_channel_id: int | None
    bot_public_url: str | None


_cached: Settings | None = None


def load() -> Settings:
    """Load settings. Cached after first call."""
    global _cached
    if _cached is not None:
        return _cached

    yaml_path = Path("config.yaml")
    yaml_data = yaml.safe_load(yaml_path.read_text()) if yaml_path.exists() else {}

    _cached = Settings(
        discord_token=os.environ["DISCORD_TOKEN"],
        guild_id=int(os.environ["GUILD_ID"]),
        mod_log_channel_id=int(os.environ["MOD_LOG_CHANNEL_ID"]),
        forty_plus_role_id=int(os.environ["FORTY_PLUS_ROLE_ID"]),
        moderator_role_id=int(os.environ["MODERATOR_ROLE_ID"]),
        admin_role_id=int(os.environ["ADMIN_ROLE_ID"]),
        timezone=os.environ.get("TIMEZONE", "America/Los_Angeles"),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
        yaml_data=yaml_data,
        bridge_channel_id=int(os.environ["BRIDGE_CHANNEL_ID"]) if os.environ.get("BRIDGE_CHANNEL_ID") else None,
        bridge_webhook_id=int(os.environ["BRIDGE_WEBHOOK_ID"]) if os.environ.get("BRIDGE_WEBHOOK_ID") else None,
        bridge_signing_secret=os.environ.get("BRIDGE_SIGNING_SECRET") or None,
        web_server_port=int(os.environ.get("WEB_SERVER_PORT", "8080")),
        invite_channel_id=int(os.environ["INVITE_CHANNEL_ID"]) if os.environ.get("INVITE_CHANNEL_ID") else None,
        bot_public_url=os.environ.get("BOT_PUBLIC_URL") or None,
    )
    return _cached
