import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  REST,
  Routes,
  MessageFlags,
} from "discord.js";

import { loadSettings } from "./core/config.js";
import { getDb, closeDb } from "./core/db.js";
import { shutdownScheduler } from "./core/scheduling.js";
import { BotModule, ModuleCommand } from "./core/types.js";
import schedulerModule from "./modules/scheduler.js";
import modNotesModule from "./modules/modNotes.js";
import redditSyncModule from "./modules/redditSync.js";
import { startWebServer } from "./web/server.js";

const settings = loadSettings();

const MODULES: BotModule[] = [schedulerModule, modNotesModule, redditSyncModule];

// If we see this many gateway disconnects within the window, exit so we
// don't keep hammering Discord and deepen any rate-limit ban.
const DISCONNECT_THRESHOLD = 5;
const DISCONNECT_WINDOW_SECS = 300;

export async function run(): Promise<void> {
  // Initialise DB up front so schema migrations don't race with cogs.
  getDb();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildInvites,
    ],
  });

  // Build a name -> handler map from each module's commands.
  const commandHandlers = new Map<string, ModuleCommand>();
  const commandJson: ModuleCommand["data"][] = [];
  for (const mod of MODULES) {
    for (const cmd of mod.commands ?? []) {
      commandHandlers.set(cmd.data.name, cmd);
      commandJson.push(cmd.data);
    }
  }

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const handler = commandHandlers.get(interaction.commandName);
    if (!handler) {
      await interaction
        .reply({
          content: "Unknown command.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    try {
      await handler.execute(interaction);
    } catch (err) {
      console.error(
        `command ${interaction.commandName} threw:`,
        err,
      );
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: "Something went wrong handling that command.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "Something went wrong handling that command.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // ignore
      }
    }
  });

  // Disconnect-loop guard.
  const disconnectTimes: number[] = [];
  client.on(Events.ShardDisconnect, async (event) => {
    const now = Date.now() / 1000;
    while (disconnectTimes.length && now - disconnectTimes[0]! > DISCONNECT_WINDOW_SECS) {
      disconnectTimes.shift();
    }
    disconnectTimes.push(now);
    console.warn(
      `gateway disconnect (code=${event.code}; ${disconnectTimes.length} in last ${DISCONNECT_WINDOW_SECS}s)`,
    );
    if (disconnectTimes.length >= DISCONNECT_THRESHOLD) {
      console.error(
        `${disconnectTimes.length} disconnects in ${DISCONNECT_WINDOW_SECS}s — doomed reconnect loop suspected. ` +
          "Shutting down to prevent rate-limit damage. Wait 10+ min and investigate before restarting.",
      );
      await shutdown(client);
      process.exit(1);
    }
  });

  client.once(Events.ClientReady, async (c) => {
    console.info(`Logged in as ${c.user.tag} (${c.user.id})`);
  });

  // Initialise modules (registers listeners + scheduler jobs).
  for (const mod of MODULES) {
    if (mod.init) await mod.init(client);
    console.info(`Loaded module: ${mod.name}`);
  }

  // Start the web server (no-op if env vars not set).
  const fastify = await startWebServer(client);

  // Login to Discord.
  await client.login(settings.discordToken);

  // Sync slash commands to the guild for instant availability.
  if (commandJson.length > 0) {
    const rest = new REST({ version: "10" }).setToken(settings.discordToken);
    const appId = client.application?.id ?? client.user!.id;
    await rest.put(
      Routes.applicationGuildCommands(appId, settings.guildId),
      { body: commandJson },
    );
    console.info(`Synced ${commandJson.length} slash commands to guild`);
  }

  // Graceful shutdown on signal.
  const onSignal = async (sig: string) => {
    console.info(`received ${sig}; shutting down`);
    if (fastify) {
      try {
        await fastify.close();
      } catch (err) {
        console.error("fastify close failed:", err);
      }
    }
    await shutdown(client);
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
}

async function shutdown(client: Client): Promise<void> {
  shutdownScheduler();
  try {
    await client.destroy();
  } catch (err) {
    console.error("client destroy failed:", err);
  }
  closeDb();
}
