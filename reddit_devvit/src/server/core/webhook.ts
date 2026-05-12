type WebhookField = { name: string; value: string; inline?: boolean };

export async function postWebhook(
  webhookUrl: string,
  title: string,
  fields: WebhookField[],
  color: number,
): Promise<void> {
  await fetch(webhookUrl, {
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
}
