import { readFileSync, statSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";

loadDotenv();

export interface ScheduledChannelEntry {
  name: string;
  channel_id: number;
  gate_role_id?: number;
  open_cron: string;
  close_cron: string;
  timezone: string;
  purge_on_close?: boolean;
  skip_pinned?: boolean;
  announce?: {
    channel_id?: number;
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

let cached: Settings | null = null;

export function loadSettings(): Settings {
  if (cached) return cached;

  const yamlPath = "config.yaml";
  let yamlData: YamlData = {};
  try {
    const stat = statSync(yamlPath);
    if (stat.isFile()) {
      yamlData = (parseYaml(readFileSync(yamlPath, "utf8")) as YamlData) ?? {};
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
