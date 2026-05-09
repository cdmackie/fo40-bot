/**
 * HTTP web server for the invite-link flow.
 *
 *   GET /join?token=<base64url(payload)>.<base64url(hmac_sha256(payload, secret))>
 *
 * Payload (JSON, base64url-encoded):
 *   { "u": "<reddit_username>", "e": <unix_epoch_seconds_when_token_expires> }
 *
 * Verifies the HMAC signature + expiry, creates a one-time-use Discord
 * invite, stores the {invite_code: reddit_username} mapping, and 302s the
 * user to discord.gg/<invite_code>. The bot's redditSync module handles
 * the join correlation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Client, ChannelType, TextChannel, NewsChannel } from "discord.js";
import Fastify, { FastifyInstance } from "fastify";

import { loadSettings } from "../core/config.js";
import { getDb } from "../core/db.js";

const settings = loadSettings();

const INVITE_MAX_AGE_SECONDS = 10 * 60;
const INVITE_MAX_USES = 1;

function b64urlDecode(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface TokenPayload {
  u: string;
  e: number;
}

function verifyToken(token: string, secret: string): TokenPayload | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payloadBytes: Buffer;
  let providedSig: Buffer;
  try {
    payloadBytes = b64urlDecode(payloadB64);
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expectedSig = createHmac("sha256", secret).update(payloadBytes).digest();
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const u = obj["u"];
  const e = obj["e"];
  if (typeof u !== "string" || !u) return null;
  if (typeof e !== "number" || e < Math.floor(Date.now() / 1000)) return null;
  return { u, e };
}

function recordPendingInvite(inviteCode: string, redditUsername: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pending_invites (invite_code, reddit_username)
       VALUES (?, ?)`,
    )
    .run(inviteCode, redditUsername);
}

function isInvitableChannel(
  channel: unknown,
): channel is TextChannel | NewsChannel {
  if (!channel || typeof channel !== "object") return false;
  const t = (channel as { type?: number }).type;
  return t === ChannelType.GuildText || t === ChannelType.GuildAnnouncement;
}

export async function startWebServer(
  client: Client,
): Promise<FastifyInstance | null> {
  if (
    !settings.bridgeSigningSecret ||
    !settings.inviteChannelId ||
    !settings.botPublicUrl
  ) {
    console.info(
      "Invite-link web server NOT started - set BRIDGE_SIGNING_SECRET, " +
        "INVITE_CHANNEL_ID, and BOT_PUBLIC_URL in .env to enable.",
    );
    return null;
  }

  const fastify = Fastify({
    logger: { level: settings.logLevel === "debug" ? "debug" : "warn" },
  });

  fastify.get("/health", async (_req, _reply) => "ok\n");

  fastify.get<{ Querystring: { token?: string } }>("/join", async (req, reply) => {
    const token = (req.query.token ?? "").toString().trim();
    if (!token) {
      reply.code(400);
      return "Missing token.\n";
    }
    if (!settings.bridgeSigningSecret || !settings.inviteChannelId) {
      reply.code(503);
      return "Invite flow not configured. Tell a moderator.\n";
    }
    const payload = verifyToken(token, settings.bridgeSigningSecret);
    if (!payload) {
      reply.code(400);
      return "Invalid or expired link. Go back to Reddit and click the button again.\n";
    }
    const redditUsername = payload.u;

    const channel = client.channels.cache.get(settings.inviteChannelId);
    if (!isInvitableChannel(channel)) {
      reply.code(503);
      return "Bot is starting up. Try again in a few seconds.\n";
    }

    let inviteCode: string;
    try {
      const invite = await channel.createInvite({
        maxAge: INVITE_MAX_AGE_SECONDS,
        maxUses: INVITE_MAX_USES,
        unique: true,
        reason: `invite-link flow for u/${redditUsername}`,
      });
      inviteCode = invite.code;
    } catch (err) {
      console.error("createInvite failed:", err);
      reply.code(502);
      return "Couldn't create a Discord invite. Try again in a minute.\n";
    }

    recordPendingInvite(inviteCode, redditUsername);
    console.info(
      `issued invite ${inviteCode} for u/${redditUsername} (ip=${req.ip})`,
    );

    reply.redirect(`https://discord.gg/${inviteCode}`, 302);
    return reply;
  });

  await fastify.listen({
    host: settings.webServerHost,
    port: settings.webServerPort,
  });
  console.info(
    `web server listening on ${settings.webServerHost}:${settings.webServerPort} ` +
      `(public URL: ${settings.botPublicUrl})`,
  );
  return fastify;
}
