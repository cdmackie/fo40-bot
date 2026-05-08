import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
} from "discord.js";
import { loadSettings } from "./config.js";

const settings = loadSettings();

export function isModerator(member: GuildMember): boolean {
  return (
    member.roles.cache.has(settings.moderatorRoleId) ||
    member.roles.cache.has(settings.adminRoleId)
  );
}

export function isAdmin(member: GuildMember): boolean {
  return member.roles.cache.has(settings.adminRoleId);
}

export function isFortyPlus(member: GuildMember): boolean {
  return member.roles.cache.has(settings.fortyPlusRoleId);
}

/**
 * Reject the interaction with an ephemeral message if the caller isn't a mod.
 * Returns true if rejected (caller should `return`); false if allowed.
 */
export async function requireModerator(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const m = interaction.member;
  if (!(m instanceof GuildMember) || !isModerator(m)) {
    await interaction.reply({
      content: "Mods or admins only.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  return false;
}

export async function requireFortyPlus(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const m = interaction.member;
  if (!(m instanceof GuildMember) || !isFortyPlus(m)) {
    await interaction.reply({
      content: "This requires the 40+ role.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  return false;
}
