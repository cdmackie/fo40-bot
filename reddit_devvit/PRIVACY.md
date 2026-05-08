# Privacy Policy — fo40-bridge

Last updated: 2026-05-08

## Operator

fo40-bridge is operated by the moderator team of r/FriendsOver40 as part of an internal integration between r/FriendsOver40 and the FriendsOver40 Discord server. It is not a commercial service and is not offered to other communities.

## What data this app handles

fo40-bridge processes exactly two kinds of events:

### 1. Subreddit ban events (automatic)

When a moderator of r/FriendsOver40 bans a user, the app reads the resulting `ModAction` event and forwards the following fields to a Discord webhook:

- The banned user's Reddit username
- The acting moderator's Reddit username
- The ban reason (as written by the moderator in the modlog)

All three fields are already visible to subreddit moderators in the Reddit modlog. No private or non-mod-visible Reddit data is transmitted.

### 2. Discord-link verification (user-initiated)

When a logged-in user clicks the "Link Discord account" menu item and submits the form, the app forwards:

- The submitting user's Reddit username (read via `context.reddit.getCurrentUser()`)
- A 6-digit one-time code that the user themselves types into the form

This is voluntary on the user's part — the form is only submitted if the user explicitly fills it in and presses Submit.

## What this app does NOT handle

The app does not collect, store, log, or transmit:

- IP addresses or device identifiers
- Post or comment contents
- Reddit DMs or chat messages
- Email addresses
- Account creation dates, karma, or other profile metadata
- Any Reddit data beyond the fields listed above

The app writes no data to Reddit's data store (Devvit Redis or otherwise) and maintains no persistent state.

## Where data goes

All outbound traffic goes to a single Discord webhook URL stored in the app's `discord_webhook_url` setting (set by an r/FriendsOver40 moderator at install time). No other external destination is contacted.

The webhook URL points to a private, moderator-only channel in the FriendsOver40 Discord server.

## Retention

fo40-bridge stores no user data itself. Once an event is forwarded to Discord, retention is governed by Discord's privacy policy and the FriendsOver40 Discord server's moderation practices.

## Your rights

- **Unlink at any time:** linked Discord users can run `/unlink-reddit` in the FriendsOver40 Discord server to remove the association.
- **Opt out of verification:** simply don't click the "Link Discord account" menu item — there is no other way for the app to send verification data about you.
- **Ban-event data:** ban events are standard moderator actions covered by Reddit's moderator-data policies. Removal of any specific ban-event data already forwarded to Discord requires contacting an r/FriendsOver40 moderator via modmail.

## Contact

Questions, removal requests, or concerns: contact the r/FriendsOver40 moderator team via modmail at https://www.reddit.com/message/compose?to=/r/FriendsOver40

## Changes

If this policy materially changes, the date at the top of this document will be updated. Continued use of the "Link Discord account" feature after such an update constitutes acceptance.
