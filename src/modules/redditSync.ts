/**
 * Reddit ↔ Discord integration via Devvit bridge + invite-link auto-verify.
 *
 * Two halves:
 *   1. Invite-link join flow. The Devvit app's pinned post button signs an
 *      HMAC token containing the user's Reddit username and redirects them
 *      to the bot's /join endpoint (web/server.ts), which creates a one-time
 *      Discord invite and stores {invite_code: reddit_username}. When the
 *      user joins, this module's on_member_join handler correlates the used
 *      invite to the stored mapping and auto-links + assigns 40+.
 *   2. Ban relay. The Devvit app POSTs ban events to a Discord webhook in a
 *      private bridge channel. on_message listener picks them up and bans
 *      the linked Discord user.
 *
 * Slash commands:
 *   /link-reddit user:<user> username:<str>  (mod-only manual)
 *   /unlink-reddit user:<user>               (mod-only manual)
 *   /reddit-status [user:<user>]             (self anyone, others mod-only)
 */
import {
  AllowedMentionsTypes,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Collection,
  EmbedBuilder,
  Events,
  GuildMember,
  Invite,
  Message,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";

import { loadSettings } from "../core/config.js";
import { getDb } from "../core/db.js";
import { isModerator, requireModerator } from "../core/permissions.js";
import { BotModule, ModuleCommand } from "../core/types.js";

const settings = loadSettings();

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const NO_PINGS = { parse: [] as AllowedMentionsTypes[] };

// ---------- DB helpers ----------

function getRedditUsername(discordId: string): string | null {
  const row = getDb()
    .prepare(`SELECT reddit_username FROM users WHERE discord_id = ?`)
    .get(discordId) as { reddit_username: string | null } | undefined;
  return row?.reddit_username ?? null;
}

function getDiscordIdForReddit(redditUsername: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT discord_id FROM users WHERE LOWER(reddit_username) = LOWER(?)`,
    )
    .get(redditUsername) as { discord_id: string } | undefined;
  return row?.discord_id ?? null;
}

function setRedditUsername(discordId: string, redditUsername: string | null): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (discord_id) VALUES (?)`).run(discordId);
  db.prepare(`UPDATE users SET reddit_username = ? WHERE discord_id = ?`).run(
    redditUsername,
    discordId,
  );
}

function consumePendingInvite(inviteCode: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT reddit_username FROM pending_invites WHERE invite_code = ?`)
    .get(inviteCode) as { reddit_username: string } | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM pending_invites WHERE invite_code = ?`).run(inviteCode);
  return row.reddit_username;
}

function logBanSync(
  source: string,
  userId: string | null,
  redditUsername: string,
  action: string,
  reason: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO ban_sync_log (source, user_id, reddit_username, action, reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(source, userId, redditUsername, action, reason);
}

// ---------- Used-invite detection ----------

/**
 * Find which of our pending invites the new member used.
 *
 * Uses `pending_invites` as the source of truth: every row there is an
 * invite the bot issued via the /join flow. When a one-use invite is
 * consumed, Discord deletes it, so it's missing from `guild.invites.fetch()`.
 * We pick the most-recently-created pending invite that's no longer present
 * (or that has uses > 0 for non-one-use cases).
 *
 * This avoids the race condition where Discord's INVITE_CREATE / INVITE_DELETE
 * gateway events arrive AFTER GUILD_MEMBER_ADD, which would defeat any
 * cache-based approach.
 */
async function identifyUsedInvite(
  member: GuildMember,
): Promise<string | null> {
  const pending = getDb()
    .prepare(`SELECT invite_code FROM pending_invites ORDER BY created_at DESC`)
    .all() as { invite_code: string }[];
  if (pending.length === 0) return null;

  let current: Collection<string, Invite>;
  try {
    current = await member.guild.invites.fetch();
  } catch (err) {
    console.warn(
      `can't list invites in ${member.guild.name}: ${(err as Error).message}. ` +
        `Grant 'Manage Server' or 'View Audit Log' to enable invite tracking.`,
    );
    return null;
  }

  for (const { invite_code } of pending) {
    const inv = current.get(invite_code);
    // Missing from current = one-use consumed (Discord deleted it on use).
    // Or, present with uses > 0 = multi-use that someone consumed.
    if (!inv || (inv.uses ?? 0) > 0) {
      return invite_code;
    }
  }
  return null;
}

async function onMemberJoin(member: GuildMember): Promise<void> {
  if (member.guild.id !== settings.guildId) return;

  const usedCode = await identifyUsedInvite(member);
  if (!usedCode) {
    console.info(
      `member ${member.id} (${member.user.username}) joined; could not determine invite`,
    );
    return;
  }
  const redditUsername = consumePendingInvite(usedCode);
  if (!redditUsername) {
    console.info(
      `member ${member.id} joined via invite ${usedCode}; no pending Reddit mapping`,
    );
    return;
  }
  setRedditUsername(member.id, redditUsername);
  console.info(
    `auto-linked discord=${member.id} to reddit=u/${redditUsername} (invite ${usedCode})`,
  );

  const role = member.guild.roles.cache.get(settings.fortyPlusRoleId);
  if (!role) {
    console.warn(`40+ role ${settings.fortyPlusRoleId} not found`);
  } else {
    try {
      await member.roles.add(role, `invite-link auto-verify from u/${redditUsername}`);
    } catch (err) {
      console.error(`failed to assign 40+ role to ${member.id}:`, err);
    }
  }

  // Set the server-specific nickname to their Reddit username so other
  // members can match Discord faces to Reddit handles. Requires the
  // 'Manage Nicknames' permission on the guild AND the bot's highest role
  // ranked above the new member's highest role (Discord's hierarchy rule).
  // Server owner is unrenameable by anyone, including bots.
  try {
    await member.setNickname(
      redditUsername,
      `linked Reddit account u/${redditUsername}`,
    );
  } catch (err) {
    console.warn(
      `failed to set nickname for ${member.id} (likely missing Manage Nicknames ` +
        `or modbot role isn't above the user's roles):`,
      (err as Error).message,
    );
  }

  try {
    await member.send(
      `Welcome to FriendsOver40! Your Discord account is now linked to u/${redditUsername} ` +
        `and you have full access to the server. ` +
        `Your server nickname has been set to your Reddit username.`,
    );
  } catch {
    // DMs probably closed - nothing critical.
  }
}

// ---------- Bridge listener (ban relay) ----------

async function onMessage(client: Client, message: Message): Promise<void> {
  if (!settings.bridgeChannelId || !settings.bridgeWebhookId) return;
  // Diagnostic: log every message in the bridge channel so we can see
  // whether the bot is receiving them and how the webhook-id filter compares.
  if (message.channelId === settings.bridgeChannelId) {
    console.info(
      `bridge msg: channel=${message.channelId} webhook_id=${message.webhookId} ` +
        `expected_webhook=${settings.bridgeWebhookId} ` +
        `match=${message.webhookId === settings.bridgeWebhookId} ` +
        `embeds=${message.embeds.length} ` +
        `titles=${JSON.stringify(message.embeds.map((e) => e.title))}`,
    );
  }
  if (message.channelId !== settings.bridgeChannelId) return;
  if (!message.webhookId || message.webhookId !== settings.bridgeWebhookId) return;
  for (const embed of message.embeds) {
    const title = (embed.title ?? "").trim();
    if (title === "[fo40-bridge] ban") {
      await handleBanEvent(client, embed);
    } else if (title === "[fo40-bridge] unban") {
      await handleUnbanEvent(client, embed);
    } else {
      console.warn(`unknown bridge embed title: ${JSON.stringify(title)}`);
    }
  }
}

async function handleBanEvent(
  client: Client,
  embed: import("discord.js").Embed,
): Promise<void> {
  const fields: Record<string, string> = {};
  for (const f of embed.fields) fields[f.name] = f.value;
  const redditUsername = (fields["reddit_username"] ?? "").trim();
  const moderator = (fields["moderator"] ?? "").trim();
  const reason = (fields["reason"] ?? "").trim().slice(0, 512);
  if (!redditUsername) {
    console.warn("ban embed missing reddit_username");
    return;
  }
  // Devvit's bulk-sync menu item sets moderator="(bulk sync)" so we can
  // suppress the per-user "no Discord link" mod-log embed for unlinked
  // users. Otherwise a 200-banned-user sync would post 200 noisy embeds
  // for the unlinked ones.
  const isBulkSync = moderator === "(bulk sync)";
  const discordId = getDiscordIdForReddit(redditUsername);
  if (!discordId) {
    logBanSync("reddit_modlog", null, redditUsername, "unlinked", reason);
    if (!isBulkSync) {
      await postModlogEmbed(client, {
        title: "Reddit ban - no Discord link",
        description:
          "Reddit banned this user, but no Discord member has linked this Reddit account. No automatic action taken.",
        color: 0x95a5a6,
        redditUsername,
        discordId: null,
        reason,
      });
    }
    return;
  }
  const guild = client.guilds.cache.get(settings.guildId);
  if (!guild) {
    console.warn(`guild not in cache; can't mirror ban for u/${redditUsername}`);
    return;
  }

  // Reddit can emit the same modlog action multiple times (replication,
  // related actions, etc.) so the same banuser event arrives 2-4x. Check
  // if Discord has already banned them; if so, treat as a duplicate and
  // skip both the redundant ban call and the duplicate mod-log post.
  const existingBan = await guild.bans.fetch(discordId).catch(() => null);
  if (existingBan) {
    console.info(
      `Discord ${discordId} already banned; skipping duplicate event from u/${redditUsername}`,
    );
    return;
  }

  try {
    await guild.members.ban(discordId, { reason: `Reddit modlog: ${reason}` });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 10007 /* Unknown Member */) {
      console.info(`Discord ${discordId} not in guild - skipping ban mirror`);
      logBanSync(
        "reddit_modlog",
        discordId,
        redditUsername,
        "skipped-not-in-guild",
        reason,
      );
      return;
    }
    console.warn(`can't ban Discord ${discordId}: ${e.message}`);
    logBanSync("reddit_modlog", discordId, redditUsername, "failed-forbidden", reason);
    await postModlogEmbed(client, {
      title: "Reddit ban - could not mirror",
      description:
        "Reddit banned this user, but the bot couldn't ban them on Discord (missing permission or role hierarchy). Manual action needed.",
      color: 0xe67e22,
      redditUsername,
      discordId,
      reason,
    });
    return;
  }
  logBanSync("reddit_modlog", discordId, redditUsername, "ban", reason);
  console.info(`mirrored Reddit ban: u/${redditUsername} -> Discord ${discordId}`);
  await postModlogEmbed(client, {
    title: "Reddit ban mirrored",
    description: "Discord ban applied automatically.",
    color: 0xe74c3c,
    redditUsername,
    discordId,
    reason,
  });
}

async function handleUnbanEvent(
  client: Client,
  embed: import("discord.js").Embed,
): Promise<void> {
  const fields: Record<string, string> = {};
  for (const f of embed.fields) fields[f.name] = f.value;
  const redditUsername = (fields["reddit_username"] ?? "").trim();
  if (!redditUsername) {
    console.warn("unban embed missing reddit_username");
    return;
  }

  const discordId = getDiscordIdForReddit(redditUsername);
  if (!discordId) {
    // No linked Discord user. Log only - no mod-log embed since unbanning
    // someone who was never linked is uneventful.
    logBanSync("reddit_modlog", null, redditUsername, "unban-unlinked", "");
    return;
  }

  const guild = client.guilds.cache.get(settings.guildId);
  if (!guild) {
    console.warn(`guild not in cache; can't mirror unban for u/${redditUsername}`);
    return;
  }

  // Dedup: same as ban events, Reddit emits the same modaction multiple
  // times. Only act if the user is actually currently banned on Discord.
  const existingBan = await guild.bans.fetch(discordId).catch(() => null);
  if (!existingBan) {
    console.info(
      `Discord ${discordId} not currently banned; skipping duplicate unban from u/${redditUsername}`,
    );
    return;
  }

  try {
    await guild.bans.remove(discordId, `Reddit unban (u/${redditUsername})`);
  } catch (err) {
    console.warn(
      `couldn't unban Discord ${discordId}: ${(err as Error).message}`,
    );
    logBanSync("reddit_modlog", discordId, redditUsername, "unban-failed", "");
    return;
  }

  logBanSync("reddit_modlog", discordId, redditUsername, "unban", "");
  console.info(`mirrored Reddit unban: u/${redditUsername} -> Discord ${discordId}`);
  await postModlogEmbed(client, {
    title: "Reddit unban mirrored",
    description: "Discord ban removed automatically.",
    color: 0x2ecc71,
    redditUsername,
    discordId,
  });
}

interface ModlogEmbedArgs {
  title: string;
  description: string;
  color: number;
  redditUsername: string;
  discordId: string | null;
  reason?: string;
}

async function postModlogEmbed(client: Client, args: ModlogEmbedArgs): Promise<void> {
  const channel = client.channels.cache.get(settings.modLogChannelId);
  if (!channel?.isSendable()) {
    console.warn(`mod-log channel ${settings.modLogChannelId} not sendable`);
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(args.title)
    .setDescription(args.description)
    .setColor(args.color)
    .setTimestamp(new Date())
    .addFields(
      { name: "Reddit user", value: `u/${args.redditUsername}`, inline: true },
    );
  if (args.discordId !== null) {
    embed.addFields({ name: "Discord", value: `<@${args.discordId}>`, inline: true });
  }
  if (args.reason !== undefined) {
    embed.addFields({
      name: "Reason",
      value: args.reason || "(no reason)",
      inline: false,
    });
  }
  try {
    await channel.send({ embeds: [embed], allowedMentions: NO_PINGS });
  } catch (err) {
    console.error("failed to post modlog embed:", err);
  }
}

// ---------- Slash commands ----------

const linkRedditCmd = new SlashCommandBuilder()
  .setName("link-reddit")
  .setDescription("Manually link a Discord user to a Reddit username (mods/admins only)")
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName("user").setDescription("Discord user to link").setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("username")
      .setDescription("Reddit username (without u/)")
      .setRequired(true),
  );

const unlinkRedditCmd = new SlashCommandBuilder()
  .setName("unlink-reddit")
  .setDescription("Remove a Discord user's Reddit link (mods/admins only)")
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName("user").setDescription("Discord user to unlink").setRequired(true),
  );

const redditStatusCmd = new SlashCommandBuilder()
  .setName("reddit-status")
  .setDescription("Show your linked Reddit account (or another user's, mods only)")
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName("user").setDescription("Optional: another user (mods/admins only)"),
  );

async function handleLink(interaction: ChatInputCommandInteraction): Promise<void> {
  if (await requireModerator(interaction)) return;
  const user = interaction.options.getUser("user", true);
  let username = interaction.options
    .getString("username", true)
    .trim()
    .replace(/^\//, "")
    .replace(/^u\//i, "")
    .trim();
  if (!USERNAME_RE.test(username)) {
    await interaction.reply({
      content:
        "That doesn't look like a valid Reddit username (3-20 chars; letters, digits, `-`, `_`).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const otherOwner = getDiscordIdForReddit(username);
  if (otherOwner && otherOwner !== user.id) {
    await interaction.reply({
      content: `u/${username} is already linked to another Discord user (<@${otherOwner}>).`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_PINGS,
    });
    return;
  }
  const existing = getRedditUsername(user.id);
  setRedditUsername(user.id, username);
  const note = existing ? ` (was u/${existing})` : "";
  await interaction.reply({
    content: `Linked ${user.toString()} to u/${username}${note}.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
  console.info(
    `manual link by ${interaction.user.id}: discord=${user.id} reddit=u/${username}`,
  );
}

async function handleUnlink(interaction: ChatInputCommandInteraction): Promise<void> {
  if (await requireModerator(interaction)) return;
  const user = interaction.options.getUser("user", true);
  const existing = getRedditUsername(user.id);
  if (!existing) {
    await interaction.reply({
      content: `${user.toString()} has no linked Reddit account.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_PINGS,
    });
    return;
  }
  setRedditUsername(user.id, null);
  await interaction.reply({
    content: `Unlinked ${user.toString()} from u/${existing}.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const otherUser = interaction.options.getUser("user");
  const lookingAtOther = otherUser !== null && otherUser.id !== interaction.user.id;
  if (lookingAtOther) {
    const m = interaction.member;
    if (!(m instanceof GuildMember) || !isModerator(m)) {
      await interaction.reply({
        content: "Looking up another user's Reddit link is mods/admins only.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
  const targetId = lookingAtOther ? otherUser!.id : interaction.user.id;
  const label = lookingAtOther ? otherUser!.displayName : "You";
  const username = getRedditUsername(targetId);
  if (!username) {
    const verb = lookingAtOther ? "has" : "have";
    await interaction.reply({
      content: `${label} ${verb} no linked Reddit account.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_PINGS,
    });
    return;
  }
  await interaction.reply({
    content: `${label}: u/${username}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
}

const commands: ModuleCommand[] = [
  { data: linkRedditCmd.toJSON(), execute: handleLink },
  { data: unlinkRedditCmd.toJSON(), execute: handleUnlink },
  { data: redditStatusCmd.toJSON(), execute: handleStatus },
];

const moduleDef: BotModule = {
  name: "redditSync",
  commands,
  init(client) {
    client.on(Events.GuildMemberAdd, (member) => {
      void onMemberJoin(member as GuildMember);
    });
    client.on(Events.MessageCreate, (msg) => {
      // We need embeds, not message content. Channel.type and webhookId
      // are present without MessageContent intent.
      void onMessage(client, msg);
    });
  },
};
export default moduleDef;
