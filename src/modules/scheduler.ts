/**
 * Scheduled-channel controller. Reads `scheduled_channels` from config.yaml
 * and registers open / close / warn cron jobs with the shared scheduler.
 *
 *   open  - grants the gate role view + send + read history on the channel;
 *           optionally posts an announcement to a different channel
 *   close - revokes the gate role's view + send (channel becomes hidden);
 *           optionally purges all non-pinned messages
 *   warn  - derives a "N minutes before close" cron via shiftCron() and
 *           posts an in-channel warning + an optional announce-channel
 *           "closing soon" message
 */
import {
  Client,
  Guild,
  PermissionsBitField,
  Role,
  TextChannel,
  GuildBasedChannel,
} from "discord.js";

import { loadSettings, ScheduledChannelEntry } from "../core/config.js";
import { addJob, shiftCron } from "../core/scheduling.js";
import { BotModule } from "../core/types.js";

const settings = loadSettings();

class ScheduledChannel {
  constructor(
    private readonly client: Client,
    public readonly cfg: ScheduledChannelEntry,
  ) {}

  get name(): string {
    return this.cfg.name;
  }

  private guild(): Guild | null {
    return this.client.guilds.cache.get(settings.guildId) ?? null;
  }

  private targetRole(guild: Guild): Role {
    if (this.cfg.gate_role_id) {
      const role = guild.roles.cache.get(this.cfg.gate_role_id);
      if (role) return role;
      console.warn(
        `[${this.name}] gate_role_id ${this.cfg.gate_role_id} not found; falling back to @everyone`,
      );
    }
    return guild.roles.everyone;
  }

  private getChannel(guild: Guild, id: string): TextChannel | null {
    const ch = guild.channels.cache.get(id);
    return ch?.isTextBased() && "permissionOverwrites" in ch
      ? (ch as TextChannel)
      : null;
  }

  async open(): Promise<void> {
    const guild = this.guild();
    if (!guild) {
      console.warn(`[${this.name}] guild not in cache; skipping open`);
      return;
    }
    const channel = this.getChannel(guild, this.cfg.channel_id);
    if (!channel) {
      console.warn(`[${this.name}] channel ${this.cfg.channel_id} not found`);
      return;
    }
    const target = this.targetRole(guild);
    await channel.permissionOverwrites.edit(
      target,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      },
      { reason: `${this.name} opens` },
    );
    const announce = this.cfg.announce ?? {};
    if (announce.channel_id && announce.open_message) {
      const ann = this.getChannel(guild, announce.channel_id);
      if (ann) await ann.send(announce.open_message);
    }
    console.info(`[${this.name}] opened (gate=${target.name})`);
  }

  async warnClose(): Promise<void> {
    const announce = this.cfg.announce ?? {};
    const inChannel = announce.close_warning_message;
    const announceMsg = announce.close_message;
    if (!inChannel && !announceMsg) return;

    const guild = this.guild();
    if (!guild) return;

    if (inChannel) {
      const channel = this.getChannel(guild, this.cfg.channel_id);
      if (channel) {
        await channel.send(inChannel);
        console.info(`[${this.name}] in-channel close warning posted`);
      } else {
        console.warn(`[${this.name}] channel not found; skipping in-channel warn`);
      }
    }
    if (announceMsg) {
      if (!announce.channel_id) {
        console.warn(`[${this.name}] close_message set but no announce.channel_id`);
      } else {
        const ann = this.getChannel(guild, announce.channel_id);
        if (ann) {
          await ann.send(announceMsg);
          console.info(`[${this.name}] close announcement posted`);
        } else {
          console.warn(`[${this.name}] announce channel not found`);
        }
      }
    }
  }

  async close(): Promise<void> {
    const guild = this.guild();
    if (!guild) {
      console.warn(`[${this.name}] guild not in cache; skipping close`);
      return;
    }
    const channel = this.getChannel(guild, this.cfg.channel_id);
    if (!channel) {
      console.warn(`[${this.name}] channel ${this.cfg.channel_id} not found`);
      return;
    }
    const target = this.targetRole(guild);
    await channel.permissionOverwrites.edit(
      target,
      {
        ViewChannel: false,
        SendMessages: false,
      },
      { reason: `${this.name} closes` },
    );

    if (this.cfg.purge_on_close) {
      await new Promise((r) => setTimeout(r, 2000));
      const skipPinned = this.cfg.skip_pinned ?? true;
      let totalDeleted = 0;
      // Bulk delete in batches of 100 (Discord's max), skipping pinned.
      // bulkDelete won't touch messages older than 14 days; fetch and delete
      // those one-by-one as a fallback.
      let lastId: string | undefined;
      while (true) {
        const fetched = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        if (fetched.size === 0) break;
        const deletable = fetched.filter((m) => !skipPinned || !m.pinned);
        const recent = deletable.filter(
          (m) => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000,
        );
        const old = deletable.filter(
          (m) => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000,
        );
        if (recent.size > 0) {
          await channel.bulkDelete(recent, true);
          totalDeleted += recent.size;
        }
        for (const m of old.values()) {
          await m.delete().catch(() => {});
          totalDeleted += 1;
        }
        if (fetched.size < 100) break;
        const last = fetched.last();
        if (!last) break;
        lastId = last.id;
      }
      console.info(`[${this.name}] purged ${totalDeleted} messages`);
    }
    console.info(`[${this.name}] closed (gate=${target.name})`);
  }
}

const moduleDef: BotModule = {
  name: "scheduler",
  init(client) {
    const entries = settings.yaml.scheduled_channels ?? [];
    for (const entry of entries) {
      const sc = new ScheduledChannel(client, entry);
      addJob(`${sc.name}:open`, entry.open_cron, entry.timezone, () => sc.open());
      addJob(`${sc.name}:close`, entry.close_cron, entry.timezone, () => sc.close());

      const announce = entry.announce ?? {};
      const warnMin = announce.close_warning_minutes;
      const hasWarnMsg =
        announce.close_warning_message || announce.close_message;
      if (warnMin && hasWarnMsg) {
        const warnCron = shiftCron(entry.close_cron, -warnMin);
        if (warnCron) {
          addJob(`${sc.name}:warn`, warnCron, entry.timezone, () => sc.warnClose());
        } else {
          console.warn(
            `[${sc.name}] could not derive warn cron from ${entry.close_cron}`,
          );
        }
      }
      console.info(`Registered scheduled channel: ${sc.name}`);
    }
  },
};
export default moduleDef;
