"""HTTP web server for the invite-link flow.

Single endpoint:

    GET /join?token=<base64url(payload)>.<base64url(hmac_sha256(payload, secret))>

Payload (JSON, base64url-encoded):
    {"u": "<reddit_username>", "e": <unix_epoch_seconds_when_token_expires>}

Flow:
    1. Devvit's "Join Discord" button on the r/FriendsOver40 pinned post signs
       a token with BRIDGE_SIGNING_SECRET and redirects the user's browser to
       BOT_PUBLIC_URL/join?token=...
    2. This server verifies the token's signature and expiry.
    3. If valid, it creates a one-time-use Discord invite for INVITE_CHANNEL_ID.
    4. It records {invite_code: reddit_username} in pending_invites.
    5. It redirects the browser to https://discord.gg/<invite_code>.
    6. The user joins Discord; the bot's on_member_join listener correlates
       the used invite to the Reddit username and applies the 40+ role.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time

import discord
from aiohttp import web

from core import config, db

log = logging.getLogger("fo40.web")
settings = config.load()

# Token expires this many seconds after Devvit signs it.
TOKEN_TTL_SECONDS = 10 * 60

# Discord invite parameters.
INVITE_MAX_AGE_SECONDS = 10 * 60  # invite expires 10 min after creation
INVITE_MAX_USES = 1


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _verify_token(token: str, secret: str) -> dict | None:
    """Verify HMAC signature + expiry. Returns payload dict or None."""
    try:
        payload_b64, sig_b64 = token.split(".", 1)
    except ValueError:
        return None
    try:
        payload_bytes = _b64url_decode(payload_b64)
        provided_sig = _b64url_decode(sig_b64)
    except (ValueError, base64.binascii.Error):
        return None
    expected_sig = hmac.new(
        secret.encode("utf-8"), payload_bytes, hashlib.sha256
    ).digest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    expires_at = payload.get("e")
    if not isinstance(expires_at, (int, float)) or expires_at < time.time():
        return None
    username = payload.get("u")
    if not isinstance(username, str) or not username:
        return None
    return payload


async def _record_pending_invite(invite_code: str, reddit_username: str) -> None:
    async with db.connect() as conn:
        await conn.execute(
            "INSERT OR REPLACE INTO pending_invites (invite_code, reddit_username) "
            "VALUES (?, ?)",
            (invite_code, reddit_username),
        )
        await conn.commit()


def make_app(bot: discord.Client) -> web.Application:
    app = web.Application()

    async def health(request: web.Request) -> web.Response:
        return web.Response(text="ok\n")

    async def join(request: web.Request) -> web.Response:
        if not settings.bridge_signing_secret or not settings.invite_channel_id:
            return web.Response(
                status=503,
                text="Invite flow not configured. Tell a moderator.\n",
            )

        token = request.query.get("token", "").strip()
        if not token:
            return web.Response(status=400, text="Missing token.\n")

        payload = _verify_token(token, settings.bridge_signing_secret)
        if payload is None:
            log.warning("token verification failed (ip=%s)", request.remote)
            return web.Response(
                status=400,
                text="Invalid or expired link. Go back to Reddit and click the button again.\n",
            )

        reddit_username = payload["u"]

        channel = bot.get_channel(settings.invite_channel_id)
        if channel is None:
            log.warning("invite channel %s not in cache", settings.invite_channel_id)
            return web.Response(
                status=503,
                text="Bot is starting up. Try again in a few seconds.\n",
            )

        try:
            invite = await channel.create_invite(
                max_age=INVITE_MAX_AGE_SECONDS,
                max_uses=INVITE_MAX_USES,
                unique=True,
                reason=f"invite-link flow for u/{reddit_username}",
            )
        except discord.HTTPException as exc:
            log.exception("create_invite failed: %s", exc)
            return web.Response(
                status=502,
                text="Couldn't create a Discord invite. Try again in a minute.\n",
            )

        await _record_pending_invite(invite.code, reddit_username)
        log.info(
            "issued invite %s for u/%s (ip=%s)",
            invite.code, reddit_username, request.remote,
        )

        # 302 to the Discord invite. Discord's app handles the rest.
        return web.HTTPFound(f"https://discord.gg/{invite.code}")

    app.router.add_get("/health", health)
    app.router.add_get("/join", join)
    return app


async def start(bot: discord.Client) -> web.AppRunner | None:
    """Start the aiohttp server. Returns the runner so caller can clean up.

    Returns None and logs (without raising) if the flow isn't configured.
    """
    if not (
        settings.bridge_signing_secret
        and settings.invite_channel_id
        and settings.bot_public_url
    ):
        log.info(
            "Invite-link web server NOT started — set BRIDGE_SIGNING_SECRET, "
            "INVITE_CHANNEL_ID, and BOT_PUBLIC_URL in .env to enable."
        )
        return None

    app = make_app(bot)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=settings.web_server_port)
    await site.start()
    log.info(
        "web server listening on 0.0.0.0:%d (public URL: %s)",
        settings.web_server_port, settings.bot_public_url,
    )
    return runner
