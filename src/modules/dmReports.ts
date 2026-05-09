/**
 * DM creeper reports - flagship DM-safety feature.
 *
 * Slash command (40+ role only):
 *   /report user:<member> context:<text>
 *
 * Posts the report to MOD_LOG_CHANNEL_ID with a four-button mod queue
 * (Dismiss / Add Note / Strike / Ban) and pings the moderator role.
 * Each report is independent - mods are notified on every report (no
 * threshold counter).
 *
 * Mod actions:
 *   - Dismiss: marks dismissed, no Discord action
 *   - Add Note: opens modal for note text, calls modNotes.addNote
 *   - Strike: opens modal for severity + reason, calls modNotes.addStrike
 *             and applies Discord-side action (timeout/ban) per severity
 *   - Ban: immediate permanent ban (no confirm step), recorded as severity-3 strike
 *
 * Each action edits the report embed in place to "ACTIONED: <action> by <mod>"
 * and removes the buttons. Separate mod-log embeds describe note/strike/ban
 * actions.
 *
 * Schema: dm_reports table tracks (status, mod_decision, mod_channel_message_id,
 * resolved_at). screenshot_url column exists but is unused - reports are
 * text-only by design.
 */
import {
  ActionRowBuilder,
  AllowedMentionsTypes,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { loadSettings } from "../core/config.js";
import { getDb } from "../core/db.js";
import { requireFortyPlus, requireModerator } from "../core/permissions.js";
import { BotModule, ModuleCommand } from "../core/types.js";
import {
  addNote,
  addStrike,
  ensureUser,
  logAction,
  MAX_TIMEOUT_DAYS,
} from "./modNotes.js";

const settings = loadSettings();
const NO_PINGS = { parse: [] as AllowedMentionsTypes[] };

// ---------- DB helpers ----------

interface ReportRow {
  id: number;
  reporter_id: string;
  reported_user_id: string;
  context: string | null;
  status: string;
  mod_decision: string | null;
  mod_channel_message_id: string | null;
}

function createReport(
  reporterId: string,
  reportedUserId: string,
  context: string,
): number {
  ensureUser(reporterId);
  ensureUser(reportedUserId);
  const info = getDb()
    .prepare(
      `INSERT INTO dm_reports (reporter_id, reported_user_id, context, status)
       VALUES (?, ?, ?, 'open')`,
    )
    .run(reporterId, reportedUserId, context);
  return Number(info.lastInsertRowid);
}

function getReport(reportId: number): ReportRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, reporter_id, reported_user_id, context, status,
              mod_decision, mod_channel_message_id
       FROM dm_reports WHERE id = ?`,
    )
    .get(reportId) as ReportRow | undefined;
  return row ?? null;
}

function setReportMessageId(reportId: number, messageId: string): void {
  getDb()
    .prepare(`UPDATE dm_reports SET mod_channel_message_id = ? WHERE id = ?`)
    .run(messageId, reportId);
}

function resolveReport(
  reportId: number,
  status: "dismissed" | "actioned",
  decision: string,
): void {
  getDb()
    .prepare(
      `UPDATE dm_reports
       SET status = ?, mod_decision = ?, resolved_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(status, decision, reportId);
}

// ---------- /report slash command ----------

const reportCmd = new SlashCommandBuilder()
  .setName("report")
  .setDescription("Report a member for sending an inappropriate DM")
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName("user").setDescription("The member who DM'd you").setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("context")
      .setDescription("Briefly describe what happened")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(1000),
  );

async function handleReport(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (await requireFortyPlus(interaction)) return;

  const reportedUser = interaction.options.getUser("user", true);
  const context = interaction.options.getString("context", true).trim();

  if (reportedUser.id === interaction.user.id) {
    await interaction.reply({
      content: "You can't report yourself.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (reportedUser.bot) {
    await interaction.reply({
      content: "You can't report bots.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer immediately so the interaction is acked before any DB / Discord
  // API work below. Without this, slow channel.send() calls can race
  // against Discord's 3-second response deadline and any race-condition
  // double-delivery would also fail with "interaction already acknowledged".
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reportId = createReport(
    interaction.user.id,
    reportedUser.id,
    context,
  );

  const channel = interaction.client.channels.cache.get(
    settings.modLogChannelId,
  );
  if (!channel?.isSendable()) {
    await interaction.editReply({
      content:
        "Couldn't post your report to the mod channel. A mod has been notified to investigate.",
    });
    console.error(
      `mod-log channel ${settings.modLogChannelId} not sendable; report ${reportId} dropped`,
    );
    return;
  }

  const embed = buildReportEmbed({
    reportId,
    reporterId: interaction.user.id,
    reportedUserId: reportedUser.id,
    context,
    status: "open",
  });

  const buttons = buildReportButtons(reportId);

  const msg = await channel.send({
    content: `<@&${settings.moderatorRoleId}>`,
    embeds: [embed],
    components: [buttons],
    allowedMentions: { roles: [settings.moderatorRoleId] },
  });

  setReportMessageId(reportId, msg.id);

  await interaction.editReply({
    content:
      `Thanks - your report has been sent to the mods. They'll review and act on it. ` +
      `Reference: report #${reportId}.`,
    allowedMentions: NO_PINGS,
  });
  console.info(
    `report #${reportId} filed: reporter=${interaction.user.id} reported=${reportedUser.id}`,
  );
}

function buildReportEmbed(args: {
  reportId: number;
  reporterId: string;
  reportedUserId: string;
  context: string;
  status: "open" | "dismissed" | "actioned";
  decision?: string;
}): EmbedBuilder {
  const colour =
    args.status === "open"
      ? 0xe74c3c
      : args.status === "dismissed"
        ? 0x95a5a6
        : 0x2ecc71;
  const titlePrefix =
    args.status === "open"
      ? "DM creeper report"
      : `DM creeper report - ${args.status.toUpperCase()}`;
  const embed = new EmbedBuilder()
    .setTitle(titlePrefix)
    .setColor(colour)
    .setTimestamp(new Date())
    .addFields(
      { name: "Reporter", value: `<@${args.reporterId}>`, inline: true },
      { name: "Reported", value: `<@${args.reportedUserId}>`, inline: true },
      { name: "Context", value: args.context.slice(0, 1024), inline: false },
    )
    .setFooter({ text: `Report #${args.reportId}` });
  if (args.decision) {
    embed.addFields({ name: "Resolution", value: args.decision, inline: false });
  }
  return embed;
}

function buildReportButtons(reportId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dmreport:dismiss:${reportId}`)
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`dmreport:note:${reportId}`)
      .setLabel("Add Note")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dmreport:strike:${reportId}`)
      .setLabel("Strike")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dmreport:ban:${reportId}`)
      .setLabel("Ban")
      .setStyle(ButtonStyle.Danger),
  );
}

// ---------- Button + modal handlers ----------

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith("dmreport:")) return;
  if (await requireModerator(interaction)) return;

  const parts = interaction.customId.split(":");
  const action = parts[1];
  const reportId = Number(parts[2]);
  const report = getReport(reportId);
  if (!report) {
    await interaction.reply({
      content: "Report not found in DB.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (report.status !== "open") {
    await interaction.reply({
      content: `Report #${reportId} has already been ${report.status}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (action) {
    case "dismiss":
      return handleDismiss(interaction, report);
    case "note":
      return showNoteModal(interaction, report);
    case "strike":
      return showStrikeModal(interaction, report);
    case "ban":
      return handleBan(interaction, report);
  }
}

async function handleDismiss(
  interaction: ButtonInteraction,
  report: ReportRow,
): Promise<void> {
  const decision = `dismissed by <@${interaction.user.id}>`;
  resolveReport(report.id, "dismissed", decision);
  await interaction.update({
    embeds: [
      buildReportEmbed({
        reportId: report.id,
        reporterId: report.reporter_id,
        reportedUserId: report.reported_user_id,
        context: report.context ?? "",
        status: "dismissed",
        decision,
      }),
    ],
    components: [],
  });
  console.info(`report #${report.id} dismissed by ${interaction.user.id}`);
}

async function handleBan(
  interaction: ButtonInteraction,
  report: ReportRow,
): Promise<void> {
  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (!guild) {
    await interaction.followUp({
      content: "No guild context.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const banReason =
    `DM creeper report #${report.id} actioned by ${interaction.user.tag}`;
  try {
    await guild.members.ban(report.reported_user_id, { reason: banReason });
  } catch (err) {
    await interaction.followUp({
      content: `Couldn't ban: ${(err as Error).message}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Record as severity-3 strike so /history shows it.
  const { id: strikeId } = addStrike(
    report.reported_user_id,
    interaction.user.id,
    3,
    `DM creeper report #${report.id}: ${report.context ?? ""}`,
    null,
  );
  const decision = `banned by <@${interaction.user.id}> (strike #${strikeId})`;
  resolveReport(report.id, "actioned", decision);
  await interaction.editReply({
    embeds: [
      buildReportEmbed({
        reportId: report.id,
        reporterId: report.reporter_id,
        reportedUserId: report.reported_user_id,
        context: report.context ?? "",
        status: "actioned",
        decision,
      }),
    ],
    components: [],
  });
  // Mod-log embed for the strike.
  const modLog = new EmbedBuilder()
    .setTitle("Strike sev 3 added (via report)")
    .setColor(0xe74c3c)
    .setTimestamp(new Date())
    .addFields(
      {
        name: "User",
        value: `<@${report.reported_user_id}> (\`${report.reported_user_id}\`)`,
        inline: false,
      },
      { name: "Mod", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Strike ID", value: String(strikeId), inline: true },
      { name: "Discord action", value: "banned", inline: true },
      { name: "Source", value: `report #${report.id}`, inline: false },
    );
  await logAction(interaction.client, modLog);
  console.info(
    `report #${report.id} actioned: banned ${report.reported_user_id} by ${interaction.user.id}`,
  );
}

async function showNoteModal(
  interaction: ButtonInteraction,
  report: ReportRow,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`dmreport-modal:note:${report.id}`)
    .setTitle(`Add note - report #${report.id}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Note text")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(1000),
      ),
    );
  await interaction.showModal(modal);
}

async function showStrikeModal(
  interaction: ButtonInteraction,
  report: ReportRow,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`dmreport-modal:strike:${report.id}`)
    .setTitle(`Strike - report #${report.id}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("severity")
          .setLabel("Severity (1=warn, 2=timeout, 3=ban)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(1),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration_days")
          .setLabel(`Timeout days (severity 2 only, 1-${MAX_TIMEOUT_DAYS})`)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(2),
      ),
    );
  await interaction.showModal(modal);
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith("dmreport-modal:")) return;
  if (await requireModerator(interaction)) return;

  const parts = interaction.customId.split(":");
  const kind = parts[1];
  const reportId = Number(parts[2]);
  const report = getReport(reportId);
  if (!report || report.status !== "open") {
    await interaction.reply({
      content: `Report #${reportId} not found or already actioned.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (kind === "note") {
    return submitNote(interaction, report);
  }
  if (kind === "strike") {
    return submitStrike(interaction, report);
  }
}

async function submitNote(
  interaction: ModalSubmitInteraction,
  report: ReportRow,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const noteText = interaction.fields.getTextInputValue("note").trim();
  const noteId = addNote(report.reported_user_id, interaction.user.id, noteText);
  const decision = `note #${noteId} added by <@${interaction.user.id}>`;
  resolveReport(report.id, "actioned", decision);

  // Edit the original report message in place.
  if (report.mod_channel_message_id) {
    const channel = interaction.client.channels.cache.get(
      settings.modLogChannelId,
    );
    if (channel?.isTextBased()) {
      try {
        const msg = await channel.messages.fetch(report.mod_channel_message_id);
        await msg.edit({
          embeds: [
            buildReportEmbed({
              reportId: report.id,
              reporterId: report.reporter_id,
              reportedUserId: report.reported_user_id,
              context: report.context ?? "",
              status: "actioned",
              decision,
            }),
          ],
          components: [],
        });
      } catch (err) {
        console.warn("couldn't edit report message:", err);
      }
    }
  }

  await interaction.editReply({
    content: `Note #${noteId} added on <@${report.reported_user_id}>.`,
    allowedMentions: NO_PINGS,
  });

  // Mod-log embed.
  const modLog = new EmbedBuilder()
    .setTitle("Note added (via report)")
    .setColor(0x3498db)
    .setTimestamp(new Date())
    .addFields(
      {
        name: "User",
        value: `<@${report.reported_user_id}> (\`${report.reported_user_id}\`)`,
        inline: false,
      },
      { name: "Mod", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Note ID", value: String(noteId), inline: true },
      { name: "Source", value: `report #${report.id}`, inline: false },
      { name: "Note", value: noteText.slice(0, 1024), inline: false },
    );
  await logAction(interaction.client, modLog);
  console.info(
    `report #${report.id} actioned: note ${noteId} on ${report.reported_user_id} by ${interaction.user.id}`,
  );
}

async function submitStrike(
  interaction: ModalSubmitInteraction,
  report: ReportRow,
): Promise<void> {
  const severityRaw = interaction.fields
    .getTextInputValue("severity")
    .trim();
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const durationRaw = (
    interaction.fields.getTextInputValue("duration_days") ?? ""
  ).trim();

  const sev = Number(severityRaw);
  if (sev !== 1 && sev !== 2 && sev !== 3) {
    await interaction.reply({
      content: "Severity must be 1, 2, or 3.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let durationDays: number | null = null;
  if (sev === 2) {
    if (!durationRaw) {
      await interaction.reply({
        content: `Severity 2 needs a duration_days value (1-${MAX_TIMEOUT_DAYS}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const d = Number(durationRaw);
    if (!Number.isInteger(d) || d < 1 || d > MAX_TIMEOUT_DAYS) {
      await interaction.reply({
        content: `duration_days must be an integer 1-${MAX_TIMEOUT_DAYS}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    durationDays = d;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Apply Discord-side action first (timeout/ban) so a failure doesn't leave a stale strike.
  let actionTaken = "none";
  let actionError: string | null = null;
  if (sev === 2) {
    const member = interaction.guild?.members.cache.get(report.reported_user_id);
    if (!member) {
      await interaction.followUp({
        content:
          `<@${report.reported_user_id}> isn't currently in the server - can't apply timeout. ` +
          "Strike not recorded.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_PINGS,
      });
      return;
    }
    try {
      await member.timeout(
        durationDays! * 86400_000,
        `Strike sev=2 (report #${report.id}) by ${interaction.user.tag}: ${reason}`,
      );
      actionTaken = `timeout ${durationDays}d`;
    } catch (err) {
      actionError = `Discord rejected the timeout: ${(err as Error).message}`;
    }
  } else if (sev === 3) {
    try {
      await interaction.guild?.members.ban(report.reported_user_id, {
        reason: `Strike sev=3 (report #${report.id}) by ${interaction.user.tag}: ${reason}`,
      });
      actionTaken = "banned";
    } catch (err) {
      actionError = `Discord rejected the ban: ${(err as Error).message}`;
    }
  }

  if (actionError) {
    await interaction.followUp({
      content: `${actionError}. Strike not recorded.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { id: strikeId, expiresAt } = addStrike(
    report.reported_user_id,
    interaction.user.id,
    sev,
    `report #${report.id}: ${reason}`,
    durationDays,
  );

  const decision = `strike #${strikeId} (sev ${sev}) by <@${interaction.user.id}>`;
  resolveReport(report.id, "actioned", decision);

  if (report.mod_channel_message_id) {
    const channel = interaction.client.channels.cache.get(
      settings.modLogChannelId,
    );
    if (channel?.isTextBased()) {
      try {
        const msg = await channel.messages.fetch(report.mod_channel_message_id);
        await msg.edit({
          embeds: [
            buildReportEmbed({
              reportId: report.id,
              reporterId: report.reporter_id,
              reportedUserId: report.reported_user_id,
              context: report.context ?? "",
              status: "actioned",
              decision,
            }),
          ],
          components: [],
        });
      } catch (err) {
        console.warn("couldn't edit report message:", err);
      }
    }
  }

  await interaction.followUp({
    content: `Strike #${strikeId} (sev ${sev}) recorded on <@${report.reported_user_id}>. Action: ${actionTaken}.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
  });

  const sevColor = sev === 1 ? 0xf1c40f : sev === 2 ? 0xe67e22 : 0xe74c3c;
  const modLog = new EmbedBuilder()
    .setTitle(`Strike sev ${sev} added (via report)`)
    .setColor(sevColor)
    .setTimestamp(new Date())
    .addFields(
      {
        name: "User",
        value: `<@${report.reported_user_id}> (\`${report.reported_user_id}\`)`,
        inline: false,
      },
      { name: "Mod", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Strike ID", value: String(strikeId), inline: true },
      { name: "Discord action", value: actionTaken, inline: true },
      { name: "Source", value: `report #${report.id}`, inline: false },
      { name: "Reason", value: reason.slice(0, 1024), inline: false },
    );
  if (expiresAt) {
    modLog.addFields({
      name: "Expires",
      value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:f>`,
      inline: false,
    });
  }
  await logAction(interaction.client, modLog);
  console.info(
    `report #${report.id} actioned: strike sev=${sev} on ${report.reported_user_id} by ${interaction.user.id}`,
  );
}

// ---------- Module wiring ----------

const commands: ModuleCommand[] = [
  { data: reportCmd.toJSON(), execute: handleReport },
];

const moduleDef: BotModule = {
  name: "dmReports",
  commands,
  init(client: Client) {
    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      try {
        if (interaction.isButton()) {
          await handleButton(interaction);
        } else if (interaction.isModalSubmit()) {
          await handleModalSubmit(interaction);
        }
      } catch (err) {
        console.error("dmReports interaction handler threw:", err);
      }
    });
  },
};
export default moduleDef;
