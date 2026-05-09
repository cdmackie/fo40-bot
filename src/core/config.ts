import { readFileSync, statSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";

loadDotenv();

export interface ScheduledChannelEntry {
  name: string;
  // Discord IDs stored as strings to preserve full snowflake precision —
  // they're parsed from YAML as BigInt and stringified at load time.
  channel_id: string;
  gate_role_id?: string;
  open_cron: string;
  close_cron: string;
  timezone: string;
  purge_on_close?: boolean;
  skip_pinned?: boolean;
  announce?: {
    channel_id?: string;
    open_message?: string;
    close_warning_minutes?: number;
    close_warning_message?: string;
    close_message?: string;
  };
}

export interface YamlData {
  scheduled_channels?: ScheduledChannelEntry[];
}

export interface Settings {
  discordToken: string;
  guildId: string;
  modLogChannelId: string;
  fortyPlusRoleId: string;
  moderatorRoleId: string;
  adminRoleId: string;
  timezone: string;
  logLevel: string;
  yaml: YamlData;
  // Reddit-bridge ban relay
  bridgeChannelId: string | null;
  bridgeWebhookId: string | null;
  // Invite-link join flow
  bridgeSigningSecret: string | null;
  webServerHost: string;
  webServerPort: number;
  inviteChannelId: string | null;
  botPublicUrl: string | null;
}

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function optional(key: string): string | null {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : null;
}

/**
 * Convert YAML-parsed data into the typed YamlData shape. With intAsBigInt
 * enabled, all integer values come back as BigInt; we convert ID fields
 * to strings (Discord IDs are conceptually opaque) and count fields back
 * to Number.
 */
function normaliseYaml(raw: unknown): YamlData {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as { scheduled_channels?: unknown[] };
  return {
    scheduled_channels: Array.isArray(obj.scheduled_channels)
      ? obj.scheduled_channels.map(normaliseScheduledChannel)
      : undefined,
  };
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  return typeof v === "bigint" ? v.toString() : String(v);
}

function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  return typeof v === "bigint" ? Number(v) : Number(v);
}

function normaliseScheduledChannel(raw: unknown): ScheduledChannelEntry {
  const e = (raw ?? {}) as Record<string, unknown>;
  const announceRaw = e["announce"] as Record<string, unknown> | undefined;
  return {
    name: String(e["name"] ?? ""),
    channel_id: asString(e["channel_id"]) ?? "",
    gate_role_id: asString(e["gate_role_id"]),
    open_cron: String(e["open_cron"] ?? ""),
    close_cron: String(e["close_cron"] ?? ""),
    timezone: String(e["timezone"] ?? ""),
    purge_on_close: e["purge_on_close"] === true,
    skip_pinned: e["skip_pinned"] !== false,
    announce: announceRaw
      ? {
          channel_id: asString(announceRaw["channel_id"]),
          open_message: announceRaw["open_message"] as string | undefined,
          close_warning_minutes: asNumber(announceRaw["close_warning_minutes"]),
          close_warning_message: announceRaw["close_warning_message"] as
            | string
            | undefined,
          close_message: announceRaw["close_message"] as string | undefined,
        }
      : undefined,
  };
}

let cached: Settings | null = null;

export function loadSettings(): Settings {
  if (cached) return cached;

  const yamlPath = "config.yaml";
  let yamlData: YamlData = {};
  try {
    const stat = statSync(yamlPath);
    if (stat.isFile()) {
      // intAsBigInt preserves full precision of large integers like Discord
      // snowflakes, which would otherwise silently round through JS Number.
      const raw = parseYaml(readFileSync(yamlPath, "utf8"), {
        intAsBigInt: true,
      });
      yamlData = normaliseYaml(raw);
    } else {
      console.warn(
        `${yamlPath} exists but isn't a regular file (it's likely an empty ` +
          `directory created by Docker because the host file was missing). ` +
          `Continuing without config.yaml. Copy config.yaml.example to ` +
          `config.yaml on the host and restart to fix.`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No config.yaml at all - that's fine, scheduler module just has nothing to schedule.
  }

  cached = {
    discordToken: required("DISCORD_TOKEN"),
    guildId: required("GUILD_ID"),
    modLogChannelId: required("MOD_LOG_CHANNEL_ID"),
    fortyPlusRoleId: required("FORTY_PLUS_ROLE_ID"),
    moderatorRoleId: required("MODERATOR_ROLE_ID"),
    adminRoleId: required("ADMIN_ROLE_ID"),
    timezone: process.env.TIMEZONE ?? "America/Los_Angeles",
    logLevel: process.env.LOG_LEVEL ?? "info",
    yaml: yamlData,
    bridgeChannelId: optional("BRIDGE_CHANNEL_ID"),
    bridgeWebhookId: optional("BRIDGE_WEBHOOK_ID"),
    bridgeSigningSecret: optional("BRIDGE_SIGNING_SECRET"),
    webServerHost: process.env.WEB_SERVER_HOST ?? "127.0.0.1",
    webServerPort: parseInt(process.env.WEB_SERVER_PORT ?? "8080", 10),
    inviteChannelId: optional("INVITE_CHANNEL_ID"),
    botPublicUrl: optional("BOT_PUBLIC_URL"),
  };
  return cached;
}
