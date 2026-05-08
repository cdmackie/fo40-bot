import {
  ChatInputCommandInteraction,
  Client,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

/**
 * A bot module (the equivalent of a discord.py "cog"). Each module exports
 * a default object implementing this interface; src/bot.ts loads them all,
 * registers their slash commands with Discord, attaches their listeners,
 * and dispatches command interactions to the right handler.
 */
export interface BotModule {
  /** Display name; appears in startup logs. */
  name: string;
  /** Slash commands this module owns. */
  commands?: ModuleCommand[];
  /** Called once after the client is ready and commands are registered. */
  init?: (client: Client) => Promise<void> | void;
}

export interface ModuleCommand {
  /** The serialized SlashCommandBuilder JSON. */
  data: RESTPostAPIApplicationCommandsJSONBody;
  /** The handler invoked when this command (any of its subcommands) fires. */
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
