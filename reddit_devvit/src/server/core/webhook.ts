type WebhookField = { name: string; value: string; inline?: boolean };

export type WebhookEmbed = {
  title: string;
  color: number;
  fields: WebhookField[];
  timestamp?: string;
};

export async function postWebhook(
  webhookUrl: string,
  title: string,
  fields: WebhookField[],
  color: number,
): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  if (!resp.ok) {
    throw new Error(
      `Discord webhook returned ${resp.status} ${resp.statusText}`,
    );
  }
}

// Send multiple embeds in a single webhook call. Discord accepts up to 10
// embeds per message, so callers should chunk accordingly. Used by the bulk
// sync-banned scheduler job to amortise Reddit's outbound-fetch throttle.
export async function postWebhookBatch(
  webhookUrl: string,
  embeds: WebhookEmbed[],
): Promise<void> {
  if (embeds.length === 0) return;
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds }),
  });
  if (!resp.ok) {
    throw new Error(
      `Discord webhook returned ${resp.status} ${resp.statusText}`,
    );
  }
}
