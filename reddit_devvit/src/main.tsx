/**
 * fo40-bridge — Devvit app for r/FriendsOver40
 *
 * Relays two kinds of events to a Discord webhook:
 *   1. ModAction (banuser): when a Reddit mod bans a user, post a "ban"
 *      embed to Discord. The Discord bot picks it up and bans the linked
 *      Discord user.
 *   2. Verification: when a Reddit user clicks "Link Discord account" in the
 *      subreddit menu and pastes their Discord-side code, post a "verify"
 *      embed. The Discord bot matches the code to a pending verification
 *      and writes the link.
 *
 * The Discord webhook URL is stored in app settings (set per-install by
 * a moderator). discord.com is on Devvit's global fetch allowlist; no
 * per-app domain approval needed.
 */

import { Devvit } from "@devvit/public-api";

Devvit.configure({
  redditAPI: true,
  http: true,
});

// ---------- Settings ----------

// Installation-scoped: each subreddit that installs this app configures its
// own webhook URL via the per-install settings page on Reddit. This lets
// multiple subreddits (each with its own companion Discord server) install
// the same app without sharing credentials.
Devvit.addSettings([
  {
    type: "string",
    name: "discord_webhook_url",
    label: "Discord webhook URL",
    helpText:
      "The webhook URL of the bridge channel in your Discord server. " +
      "Create it in Channel Settings → Integrations → Webhooks.",
    scope: "installation",
    isSecret: true,
  },
]);

async function postToDiscord(
  webhookUrl: string,
  title: string,
  fields: { name: string; value: string; inline?: boolean }[],
  color: number,
): Promise<void> {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title,
          color,
          fields,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
}

// ---------- ModAction trigger: relay bans to Discord ----------

Devvit.addTrigger({
  event: "ModAction",
  onEvent: async (event, context) => {
    if (event.action !== "banuser") return;

    const webhookUrl = (await context.settings.get(
      "discord_webhook_url",
    )) as string | undefined;
    if (!webhookUrl) {
      console.warn("[fo40-bridge] discord_webhook_url not configured; skipping");
      return;
    }

    const targetUser = event.targetUser?.name;
    if (!targetUser) {
      console.warn("[fo40-bridge] ban event missing targetUser; skipping");
      return;
    }

    const moderator = event.moderator?.name ?? "?";
    const reason = (event.description ?? "").slice(0, 1024) || "(no reason)";

    try {
      await postToDiscord(
        webhookUrl,
        "[fo40-bridge] ban",
        [
          { name: "reddit_username", value: targetUser, inline: true },
          { name: "moderator", value: moderator, inline: true },
          { name: "reason", value: reason, inline: false },
        ],
        0xe74c3c,
      );
      console.log(`[fo40-bridge] relayed ban: u/${targetUser}`);
    } catch (err) {
      console.error("[fo40-bridge] failed to relay ban:", err);
    }
  },
});

// ---------- Verification flow: subreddit menu item + form ----------

const linkForm = Devvit.createForm(
  {
    fields: [
      {
        type: "string",
        name: "code",
        label: "Discord code",
        helpText:
          "Paste the 6-digit code you got from `/link-reddit` in Discord.",
        required: true,
      },
    ],
    title: "Link your Discord account",
    acceptLabel: "Link",
  },
  async (event, context) => {
    const code = (event.values.code as string | undefined)?.trim();
    if (!code) {
      context.ui.showToast("No code entered.");
      return;
    }

    const webhookUrl = (await context.settings.get(
      "discord_webhook_url",
    )) as string | undefined;
    if (!webhookUrl) {
      context.ui.showToast("Bridge not configured. Tell a mod.");
      return;
    }

    const user = await context.reddit.getCurrentUser();
    const username = user?.username;
    if (!username) {
      context.ui.showToast("Couldn't read your Reddit username — try again.");
      return;
    }

    try {
      await postToDiscord(
        webhookUrl,
        "[fo40-bridge] verify",
        [
          { name: "reddit_username", value: username, inline: true },
          { name: "code", value: code, inline: true },
        ],
        0x3498db,
      );
      context.ui.showToast(
        "Sent. Check Discord for a DM from the bot confirming the link.",
      );
    } catch (err) {
      console.error("[fo40-bridge] failed to relay verify:", err);
      context.ui.showToast("Couldn't reach Discord. Try again in a minute.");
    }
  },
);

Devvit.addMenuItem({
  label: "Link Discord account",
  location: "subreddit",
  forUserType: "loggedIn",
  onPress: async (_event, context) => {
    context.ui.showForm(linkForm);
  },
});

export default Devvit;
