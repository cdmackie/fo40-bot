/**
 * Mod notes & strikes - /note, /strike, /history slash commands.
 *
 * Module-level helpers (`addNote`, `addStrike`, `getHistory`, etc.) are
 * exported so other modules (e.g. dmReports later) can record mod actions
 * without re-implementing the DB plumbing.
 */
import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  User,
  AllowedMentionsTypes,
} from "discord.js";

import { loadSettings } from "../core/config.js";
import { getDb } from "../core/db.js";
import { requireModerator } from "../core/permissions.js";
import { BotModule, ModuleCommand } from "../core/types.js";

const settings = loadSettings();

export const WARN_EXPIRY_DAYS = 90;
export const MAX_TIMEOUT_DAYS = 28;
const NO_PINGS = { parse: [] as AllowedMentionsTypes[] };

// ---------- DB helpers (exported for cross-module use) ----------

export function ensureUser(userId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (discord_id) VALUES (?)`)
    .run(userId);
}

export function addNote(userId: string, modId: string, note: string): number {
  ensureUser(userId);
  const info = getDb()
    .prepare(`INSERT INTO mod_notes (user_id, mod_id, note) VALUES (?, ?, ?)`)
    .run(userId, modId, note);
  return Number(info.lastInsertRowid);
}

export function removeNote(
  noteId: number,
): { user_id: string; mod_id: string; note: string } | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT user_id, mod_id, note FROM mod_notes WHERE id = ?`)
    .get(noteId) as { user_id: string; mod_id: string; note: string } | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM mod_notes WHERE id = ?`).run(noteId);
  return row;
}

interface NoteRow {
  id: number;
  mod_id: string;
  note: string;
  created_at: string;
}
export function getNotes(userId: string): NoteRow[] {
  return getDb()
    .prepare(
      `SELECT id, mod_id, note, created_at FROM mod_notes
       WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as NoteRow[];
}

interface StrikeRow {
  id: number;
  mod_id: string;
  severity: number;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}
export function getActiveStrikes(userId: string): StrikeRow[] {
  return getDb()
    .prepare(
      `SELECT id, mod_id, severity, reason, created_at, expires_at
       FROM strikes
       WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at DESC`,
    )
    .all(userId) as StrikeRow[];
}

export function addStrike(
  userId: string,
  modId: string,
  severity: 1 | 2 | 3,
  reason: string,
  durationDays: number | null,
): { id: number; expiresAt: Date | null } {
  ensureUser(userId);
  const now = new Date();
  let expiresAt: Date | null = null;
  if (severity === 1) {
    expiresAt = new Date(now.getTime() + WARN_EXPIRY_DAYS * 86400_000);
  } else if (severity === 2 && durationDays !== null) {
    expiresAt = new Date(now.getTime() + durationDays * 86400_000);
  }
  const info = getDb()
    .prepare(
      `INSERT INTO strikes (user_id, mod_id, severity, reason, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, modId, severity, reason, expiresAt ? expiresAt.toISOString() : null);
  return { id: Number(info.lastInsertRowid), expiresAt };
}

interface HistoryRow {
  kind: string;
  id: number;
  created_at: string;
  actor_id: string;
  detail: string;
  severity: number | null;
  status: string | null;
}
export function getHistory(userId: string): HistoryRow[] {
  return getDb()
    .prepare(
      `SELECT 'note' AS kind, id, created_at, mod_id AS actor_id,
              note AS detail, NULL AS severity, NULL AS status
       FROM mod_notes WHERE user_id = ?
       UNION ALL
       SELECT 'strike' AS kind, id, created_at, mod_id AS actor_id,
              reason AS detail, severity, NULL AS status
       FROM strikes WHERE user_id = ?
       UNION ALL
       SELECT 'reported' AS kind, id, created_at, reporter_id AS actor_id,
              COALESCE(context, '') AS detail, NULL AS severity, status
       FROM dm_reports WHERE reported_user_id = ?
       UNION ALL
       SELECT 'reporter' AS kind, id, created_at, reported_user_id AS actor_id,
              COALESCE(context, '') AS detail, NULL AS severity, status
       FROM dm_reports WHERE reporter_id = ?
       ORDER BY created_at DESC`,
    )
    .all(userId, userId, userId, userId) as HistoryRow[];
}

export async function logAction(
  client: Client,
  embed: EmbedBuilder,
): Promise<void> {
  const channel = client.channels.cache.get(settings.modLogChannelId);
  if (!channel || !channel.isSendable()) {
    console.warn(`mod-log channel ${settings.modLogChannelId} not in cache`);
    return;
  }
  try {
    await channel.send({ embeds: [embed], allowedMentions: NO_PINGS });
  } catch (err) {
    console.error("failed to post mod-log embed:", err);
  }
}

// ---------- Helpers ----------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function ts(iso: string): number {
  // SQLite CURRENT_TIMESTAMP yields "YYYY-MM-DD HH:MM:SS" without tz.
  // Our own writes use ISO with tz. Both parseable by Date if we
  // normalise the space to T and assume UTC for naive ones.
  const normalised = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return Math.floor(new Date(normalised).getTime() / 1000);
}

function severityColor(sev: number): number {
  return sev === 1 ? 0xf1c40f : sev === 2 ? 0xe67e22 : 0xe74c3c;
}

// ---------- Slash commands ----------

// setDefaultMemberPermissions hides the command from users who lack the
// listed Discord permission. It's a UX filter, not security - the bot's
// requireModerator check is the actual access control. Pick ManageMessages
// because every mod role has it.
const noteCmd = new SlashCommandBuilder()
  .setName("note")
  .setDescription("Private mod notes on users")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a private mod note on a user")
      .addUserOption((o) =>
        o.setName("user").setDescription("Member to note").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("note").setDescription("The note text").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("view")
      .setDescription("View all notes on a user")
      .addUserOption((o) =>
        o
          .setName("user")
          .setDescription("Member to view notes for")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Delete a note by its ID")
      .addIntegerOption((o) =>
        o.setName("note_id").setDescription("Note ID").setRequired(true),
      ),
  );

const strikeCmd = new SlashCommandBuilder()
  .setName("strike")
  .setDescription("User strikes (warn / timeout / ban)")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Record a strike on a user")
      .addUserOption((o) =>
        o.setName("user").setDescription("Member to strike").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("severity")
          .setDescription("1 = warning, 2 = timeout, 3 = ban (immediate)")
          .setRequired(true)
          .addChoices(
            { name: "1 - Warning", value: 1 },
            { name: "2 - Timeout", value: 2 },
            { name: "3 - Ban", value: 3 },
          ),
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("duration_days")
          .setDescription("For severity 2: timeout days (1-28)")
          .setMinValue(1)
          .setMaxValue(MAX_TIMEOUT_DAYS),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("view")
      .setDescription("View active strikes on a user")
      .addUserOption((o) =>
        o
          .setName("user")
          .setDescription("Member to view strikes for")
          .setRequired(true),
      ),
  );

const historyCmd = new SlashCommandBuilder()
  .setName("history")
  .setDescription("Combined moderation history for a user")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("Member to view history for")
      .setRequired(true),
  );

async function execute(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  if (await requireModerator(interaction)) return;

  const cmd = interaction.commandName;
  const sub = interaction.options.getSubcommand(false);

  if (cmd === "note" && sub === "add") return handleNoteAdd(interaction, client);
  if (cmd === "note" && sub === "view") return handleNoteView(interaction);
  if (cmd === "note" && sub === "remove")
    return handleNoteRemove(interaction, client);
  if (cmd === "strike" && sub === "add")
    return handleStrikeAdd(interaction, client);
  if (cmd === "strike" && sub === "view") return handleStrikeView(interaction);
  if (cmd === "history") return handleHistory(interaction);

  await interaction.reply({
    content: "Unknown command.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleNoteAdd(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const note = interaction.options.getString("note", true);
  const noteId = addNote(user.id, interaction.user.id, note);
  await interaction.reply({
    content: `Note #${noteId} added on ${user.toString()}.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
  const embed = new EmbedBuilder()
    .setTitle("Note added")
    .setColor(0x3498db)
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: `${user.toString()} (\`${user.id}\`)`, inline: false },
      { name: "Mod", value: interaction.user.toString(), inline: true },
      { name: "Note ID", value: String(noteId), inline: true },
      { name: "Note", value: truncate(note, 1024), inline: false },
    );
  await logAction(client, embed);
}

async function handleNoteView(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const notes = getNotes(user.id);
  if (notes.length === 0) {
    await interaction.reply({
      content: `No notes on ${user.toString()}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_PINGS,
    });
    return;
  }
  const lines = notes.map(
    (n) =>
      `**#${n.id}** [<t:${ts(n.created_at)}:f>] by <@${n.mod_id}>: ${n.note}`,
  );
  const desc = truncate(lines.join("\n"), 4000);
  const embed = new EmbedBuilder()
    .setTitle(`Notes on ${user.displayName} (${notes.length})`)
    .setColor(0x3498db)
    .setDescription(desc);
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
}

async function handleNoteRemove(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  const noteId = interaction.options.getInteger("note_id", true);
  const deleted = removeNote(noteId);
  if (!deleted) {
    await interaction.reply({
      content: `Note #${noteId} not found.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: `Note #${noteId} deleted.`,
    flags: MessageFlags.Ephemeral,
  });
  const embed = new EmbedBuilder()
    .setTitle("Note removed")
    .setColor(0x95a5a6)
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: `<@${deleted.user_id}>`, inline: false },
      { name: "Removed by", value: interaction.user.toString(), inline: true },
      { name: "Note ID", value: String(noteId), inline: true },
      {
        name: "Original text",
        value: truncate(deleted.note, 1024),
        inline: false,
      },
    );
  await logAction(client, embed);
}

async function handleStrikeAdd(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const sev = interaction.options.getInteger("severity", true) as 1 | 2 | 3;
  const reason = interaction.options.getString("reason", true);
  const durationDays = interaction.options.getInteger("duration_days");

  if (sev === 2 && durationDays === null) {
    await interaction.reply({
      content: "Severity-2 (timeout) needs `duration_days` (1-28).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let actionTaken = "none";
  let actionError: string | null = null;

  if (sev === 2) {
    const member = interaction.guild?.members.cache.get(user.id);
    if (!member) {
      await interaction.followUp({
        content: `${user.toString()} isn't currently in the server - can't apply timeout. No strike recorded.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_PINGS,
      });
      return;
    }
    try {
      await member.timeout(
        durationDays! * 86400_000,
        `Strike sev=2 by ${interaction.user.tag}: ${reason}`,
      );
      actionTaken = `timeout ${durationDays}d`;
    } catch (err) {
      actionError = `Discord rejected the timeout: ${(err as Error).message}`;
    }
  } else if (sev === 3) {
    try {
      await interaction.guild?.members.ban(user.id, {
        reason: `Strike sev=3 by ${interaction.user.tag}: ${reason}`,
      });
      actionTaken = "banned";
    } catch (err) {
      actionError = `Discord rejected the ban: ${(err as Error).message}`;
    }
  }

  if (actionError) {
    await interaction.followUp({
      content: `${actionError}. No strike recorded.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { id, expiresAt } = addStrike(
    user.id,
    interaction.user.id,
    sev,
    reason,
    durationDays,
  );

  await interaction.followUp({
    content: `Strike #${id} (sev ${sev}) recorded on ${user.toString()}. Action: ${actionTaken}.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });

  const embed = new EmbedBuilder()
    .setTitle(`Strike sev ${sev} added`)
    .setColor(severityColor(sev))
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: `${user.toString()} (\`${user.id}\`)`, inline: false },
      { name: "Mod", value: interaction.user.toString(), inline: true },
      { name: "Strike ID", value: String(id), inline: true },
      { name: "Discord action", value: actionTaken, inline: true },
      { name: "Reason", value: truncate(reason, 1024), inline: false },
    );
  if (expiresAt) {
    embed.addFields({
      name: "Expires",
      value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:f>`,
      inline: false,
    });
  }
  await logAction(client, embed);
}

async function handleStrikeView(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const strikes = getActiveStrikes(user.id);
  if (strikes.length === 0) {
    await interaction.reply({
      content: `No active strikes on ${user.toString()}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_PINGS,
    });
    return;
  }
  const lines = strikes.map((s) => {
    const exp = s.expires_at
      ? ` (expires <t:${ts(s.expires_at)}:R>)`
      : "";
    const reason = s.reason ?? "(no reason)";
    return `**#${s.id}** sev ${s.severity} [<t:${ts(s.created_at)}:f>] by <@${s.mod_id}>: ${reason}${exp}`;
  });
  const desc = truncate(lines.join("\n"), 4000);
  const embed = new EmbedBuilder()
    .setTitle(`Active strikes on ${user.displayName} (${strikes.length})`)
    .setColor(0xe67e22)
    .setDescription(desc);
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
}

async function handleHistory(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const rows = getHistory(user.id);
  if (rows.length === 0) {
    await interaction.reply({
      content: `No history for ${user.toString()}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_PINGS,
    });
    return;
  }
  const lines = rows.map((r) => {
    const t = ts(r.created_at);
    if (r.kind === "note")
      return `\`NOTE\` <t:${t}:d> #${r.id} by <@${r.actor_id}>: ${r.detail}`;
    if (r.kind === "strike")
      return `\`STRIKE sev${r.severity}\` <t:${t}:d> #${r.id} by <@${r.actor_id}>: ${r.detail}`;
    if (r.kind === "reported")
      return `\`REPORTED (${r.status})\` <t:${t}:d> #${r.id} by <@${r.actor_id}>: ${r.detail}`;
    return `\`REPORTER (${r.status})\` <t:${t}:d> #${r.id} target <@${r.actor_id}>: ${r.detail}`;
  });
  const desc = truncate(lines.join("\n"), 4000);
  const embed = new EmbedBuilder()
    .setTitle(`History - ${user.displayName}`)
    .setColor(0x9b59b6)
    .setDescription(desc);
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });
}

const commands: ModuleCommand[] = [
  {
    data: noteCmd.toJSON(),
    execute: (i) => execute(i, i.client),
  },
  {
    data: strikeCmd.toJSON(),
    execute: (i) => execute(i, i.client),
  },
  {
    data: historyCmd.toJSON(),
    execute: (i) => execute(i, i.client),
  },
];

const moduleDef: BotModule = {
  name: "modNotes",
  commands,
};
export default moduleDef;
