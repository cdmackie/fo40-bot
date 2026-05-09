/**
 * fo40-bridge - Devvit app for r/FriendsOver40
 *
 * Two integrations with the FriendsOver40 Discord bot:
 *
 *   1. Modlog ban relay. Listens for `ModAction` triggers and POSTs banuser
 *      events to a Discord webhook URL stored in the install setting
 *      `discord_webhook_url`. The Discord bot reads them from a private
 *      bridge channel and bans the linked Discord user.
 *
 *   2. Invite-link join flow. Provides a "Get Discord invite" custom post
 *      type. When a logged-in Reddit user clicks the button on that post,
 *      this app signs an HMAC token containing their Reddit username and
 *      navigates them to the bot's web server (`bot_join_url`). The bot
 *      verifies the signature, creates a one-time-use Discord invite, and
 *      redirects to discord.gg/<code>. On member join, the bot links the
 *      Discord account to the Reddit username and assigns the 40+ role.
 *
 * Settings (per-install, configured by the subreddit's mods):
 *   discord_webhook_url  - Discord webhook URL of the bridge channel
 *   signing_secret       - shared HMAC secret with the Discord bot
 *   bot_join_url         - public URL of the bot's web server (e.g.
 *                          https://fo40.example.com/join)
 *
 * Mods create the "Join the Discord" pinned post via the subreddit menu
 * item "Create Discord-join post (mods only)".
 */

import { Devvit } from "@devvit/public-api";

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

// Token TTL (seconds). Must match the bot's TOKEN_TTL_SECONDS.
const TOKEN_TTL_SECONDS = 10 * 60;

// How long to remember "we already relayed this event" for trigger-burst
// dedup. Reddit emits the same modaction 4-8x within a few seconds; we
// only want to relay it once. 10 minutes is well above the burst window
// while still letting the dedup keys expire so Redis doesn't grow.
const DEDUP_TTL_SECONDS = 10 * 60;

/**
 * Returns true if this exact modaction event has already been relayed
 * (and we should skip), false if this is the first sighting.
 *
 * Uses {action, targetUser, actionedAt} as the dedup key - Reddit's
 * burst emissions all share the same actionedAt timestamp, so they
 * hash to the same key.
 */
async function alreadyRelayed(
  context: Devvit.Context,
  action: string,
  username: string,
  actionedAt: unknown,
): Promise<boolean> {
  const ts = actionedAt instanceof Date
    ? actionedAt.toISOString()
    : typeof actionedAt === "string"
      ? actionedAt
      : "";
  if (!ts) return false; // no timestamp - can't dedup; better to relay than drop
  const fieldName = `${action}:${username}:${ts}`;
  const hashKey = "bridge-dedup";
  try {
    // hSetNX is atomic: returns true if the field was newly set, false if
    // it already existed. This wins the race when multiple duplicate
    // emissions hit the dedup at the same instant - only one returns
    // "newly set", the others return "already exists" and skip.
    const wasNew = await context.redis.hSetNX(hashKey, fieldName, "1");
    if (!wasNew) return true; // someone else already relayed this event
    // Refresh hash expiry so old dedup entries eventually clean up.
    await context.redis.expire(hashKey, DEDUP_TTL_SECONDS);
  } catch (err) {
    console.warn("[fo40-bridge] redis dedup failed; relaying anyway:", err);
  }
  return false;
}

// ---------- Settings ----------

Devvit.addSettings([
  {
    type: "string",
    name: "discord_webhook_url",
    label: "Discord webhook URL (ban relay)",
    helpText:
      "The webhook URL of the bridge channel in your Discord server. " +
      "Receives ModAction ban events. Create it in Channel Settings → " +
      "Integrations → Webhooks.",
    scope: "installation",
  },
  {
    type: "string",
    name: "signing_secret",
    label: "Signing secret (invite-link flow)",
    helpText:
      "Shared HMAC secret for the invite-link flow. Must match " +
      "BRIDGE_SIGNING_SECRET in the Discord bot's .env. Use a random " +
      "string at least 32 chars long.",
    scope: "installation",
  },
  {
    type: "string",
    name: "bot_join_url",
    label: "Bot join URL (invite-link flow)",
    helpText:
      "Public URL of the Discord bot's /join endpoint, e.g. " +
      "https://fo40.example.com/join . The 'Get Discord invite' button " +
      "redirects users here with a signed token in the query string.",
    scope: "installation",
  },
]);

// ---------- HMAC signing ----------

function bytesToBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signToken(payload: object, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(new Uint8Array(sigBuf))}`;
}

// ---------- Modlog ban relay ----------

async function postWebhook(
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

Devvit.addTrigger({
  event: "ModAction",
  onEvent: async (event, context) => {
    if (event.action !== "banuser" && event.action !== "unbanuser") return;

    const webhookUrl = (await context.settings.get(
      "discord_webhook_url",
    )) as string | undefined;
    if (!webhookUrl) {
      console.warn("[fo40-bridge] discord_webhook_url not configured; skipping");
      return;
    }

    const targetUser = event.targetUser?.name;
    if (!targetUser) {
      console.warn(
        `[fo40-bridge] ${event.action} event missing targetUser; skipping`,
      );
      return;
    }

    // Dedup Reddit's 4-8x duplicate trigger emissions for the same logical
    // action. Skip silently if we've already relayed this event - keeps
    // the bridge channel clean.
    if (
      await alreadyRelayed(
        context,
        event.action,
        targetUser,
        event.actionedAt,
      )
    ) {
      return;
    }

    const moderator = event.moderator?.name ?? "?";

    if (event.action === "unbanuser") {
      try {
        await postWebhook(
          webhookUrl,
          "[fo40-bridge] unban",
          [
            { name: "reddit_username", value: targetUser, inline: true },
            { name: "moderator", value: moderator, inline: true },
          ],
          0x2ecc71,
        );
        console.log(`[fo40-bridge] relayed unban: u/${targetUser}`);
      } catch (err) {
        console.error("[fo40-bridge] failed to relay unban:", err);
      }
      return;
    }

    // The ModAction trigger event doesn't include description/details for
    // banuser. Reddit DOES expose them via the modlog REST endpoint
    // (getModerationLog), so we fetch the most recent banuser entry for
    // this target user and pull the reason from there. If the fetch fails
    // or returns nothing (race, missing perms, etc.) we fall back to
    // "(no reason)" so the ban is still mirrored.
    const subredditName = event.subreddit?.name;
    let reason = "(no reason)";
    if (subredditName) {
      try {
        const subreddit = await context.reddit.getSubredditByName(subredditName);
        const logListing = subreddit.getModerationLog({
          type: "banuser",
          limit: 25,
        });
        for await (const entry of logListing) {
          if (entry.target?.author === targetUser) {
            const desc = (entry.description ?? "").trim();
            const det = (entry.details ?? "").trim();
            const combined = [desc, det].filter(Boolean).join(": ");
            if (combined) {
              reason = combined.slice(0, 1024);
            }
            break;
          }
        }
      } catch (err) {
        console.warn("[fo40-bridge] modlog reason fetch failed:", err);
      }
    }

    try {
      await postWebhook(
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

// ---------- Invite-link custom post ----------

async function handleJoinPress(context: Devvit.Context): Promise<void> {
  const secret = (await context.settings.get("signing_secret")) as string | undefined;
  const botUrl = (await context.settings.get("bot_join_url")) as string | undefined;

  if (!secret || !botUrl) {
    context.ui.showToast(
      "This community's Discord link isn't fully set up yet. Tell a mod.",
    );
    return;
  }

  const user = await context.reddit.getCurrentUser();
  const username = user?.username;
  if (!username) {
    context.ui.showToast(
      "Couldn't read your Reddit username. Are you logged in?",
    );
    return;
  }

  try {
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const token = await signToken({ u: username, e: expiresAt }, secret);
    const sep = botUrl.includes("?") ? "&" : "?";
    const url = `${botUrl}${sep}token=${encodeURIComponent(token)}`;
    context.ui.navigateTo(url);
  } catch (err) {
    console.error("[fo40-bridge] failed to issue join URL:", err);
    context.ui.showToast("Couldn't create your invite right now. Try again in a moment.");
  }
}

Devvit.addCustomPostType({
  name: "Join Discord",
  description:
    "A pinned post inviting Reddit users to join the FriendsOver40 Discord. " +
    "Clicking the button gives them a one-time-use invite that auto-verifies " +
    "their Reddit identity on join.",
  render: (context) => {
    // No explicit backgroundColor / colors - Devvit's neutral semantic tokens
    // adapt automatically to the user's light or dark theme.
    // Title text is omitted: the post title ("Join the FriendsOver40 Discord")
    // already shows above the post body in Reddit's UI.
    return (
      <vstack
        alignment="start middle"
        gap="medium"
        padding="large"
        height="100%"
      >
        <text size="medium" color="neutral-content-weak" wrap>
          A Discord server operated by the mods of FriendsOver40 and
          FriendsOver50. Click below to get your personal invite. We
          automatically link your Reddit identity so the mods know you're
          one of us.
        </text>
        <text size="medium" color="neutral-content-weak" wrap>
          Reddit will ask you if you want to continue to an external site -
          that's normal. The link goes to friendsover40.online, the domain
          of our Reddit/Discord bot run by the mods, which links up your
          account and creates your personal Discord server invite.
        </text>
        <spacer size="small" />
        <hstack alignment="center middle" width="100%">
          <button
            appearance="primary"
            size="medium"
            onPress={async () => {
              await handleJoinPress(context);
            }}
          >
            Get Discord invite
          </button>
        </hstack>
        <hstack alignment="center middle" width="100%">
          <text size="xsmall" color="neutral-content-weak">
            One-time use · expires in 10 minutes
          </text>
        </hstack>
      </vstack>
    );
  },
});

// ---------- Mod helper: create the welcome post ----------

Devvit.addMenuItem({
  label: "Create Discord-join post (mods only)",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    // Use the subreddit name Devvit injects into the context based on
    // where the menu was clicked. context.reddit.getCurrentSubreddit()
    // can return the wrong sub in playtest contexts.
    const subredditName = context.subredditName;
    if (!subredditName) {
      context.ui.showToast(
        "Couldn't determine current subreddit. Try clicking the menu from the subreddit page directly.",
      );
      return;
    }
    const post = await context.reddit.submitPost({
      title: "Join the FriendsOver40 Discord",
      subredditName,
      preview: (
        <vstack alignment="center middle" gap="medium" padding="large">
          <text>Loading…</text>
        </vstack>
      ),
    });
    context.ui.showToast(
      `Created post in r/${subredditName}. Pin it to your subreddit.`,
    );
    context.ui.navigateTo(post);
  },
});

// ---------- Bulk-sync banned users to Discord ----------
//
// The ModAction trigger only catches NEW bans after the bot is running.
// Users banned before setup, or bans missed during downtime, won't propagate
// without an explicit reconciliation. This menu item fetches the current
// banned-users list and POSTs a ban event for each. The Discord bot's
// "already banned on Discord, skip" dedup handles re-runs safely.

Devvit.addMenuItem({
  label: "Sync banned users to Discord (mods only)",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    const webhookUrl = (await context.settings.get(
      "discord_webhook_url",
    )) as string | undefined;
    if (!webhookUrl) {
      context.ui.showToast(
        "discord_webhook_url not configured. Set it in app install settings first.",
      );
      return;
    }

    const subredditName = context.subredditName;
    if (!subredditName) {
      context.ui.showToast(
        "Couldn't determine current subreddit. Try clicking the menu from the subreddit page directly.",
      );
      return;
    }
    const subreddit = await context.reddit.getSubredditByName(subredditName);
    context.ui.showToast(
      `Syncing banned users from r/${subredditName} to Discord. Watch the bridge channel.`,
    );

    let sent = 0;
    let errors = 0;
    try {
      const bannedListing = subreddit.getBannedUsers({ limit: 1000 });
      for await (const banned of bannedListing) {
        try {
          await postWebhook(
            webhookUrl,
            "[fo40-bridge] ban",
            [
              { name: "reddit_username", value: banned.username, inline: true },
              { name: "moderator", value: "(bulk sync)", inline: true },
              {
                name: "reason",
                value: "(bulk sync from banned-users list)",
                inline: false,
              },
            ],
            0xe74c3c,
          );
          sent += 1;
        } catch (err) {
          console.error(
            `[fo40-bridge] sync: failed to relay ban for u/${banned.username}:`,
            err,
          );
          errors += 1;
        }
      }
    } catch (err) {
      console.error("[fo40-bridge] sync: failed to list banned users:", err);
      context.ui.showToast(
        "Couldn't list banned users. Check that the app has 'access' permission.",
      );
      return;
    }

    console.log(`[fo40-bridge] bulk sync: ${sent} sent, ${errors} errors`);
    context.ui.showToast(
      `Bulk sync done: ${sent} ban events sent (${errors} errors).`,
    );
  },
});

export default Devvit;
