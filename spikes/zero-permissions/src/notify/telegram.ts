// Telegram adapter. Outbound sendMessage with an inline URL button pointing at
// our ack webhook. NOTE: the button opens a URL, so ackUrl must be publicly
// reachable (set PUBLIC_BASE_URL to a tunnel) for a real phone tap to hit us.
export async function sendTelegram(opts: {
  token?: string;
  chatId: string;
  text: string;
  ackUrl?: string;
}): Promise<boolean> {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const body: Record<string, unknown> = { chat_id: opts.chatId, text: opts.text };
  if (opts.ackUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: "✅ Done", url: opts.ackUrl }]],
    };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

// Resolve a chat id from recent updates (after the user DMs the bot once).
export async function resolveChatId(token = process.env.TELEGRAM_BOT_TOKEN): Promise<string | undefined> {
  if (!token) return undefined;
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const j = (await res.json()) as { ok?: boolean; result?: any[] };
  if (!j.ok) return undefined;
  for (const u of j.result ?? []) {
    const id = u.message?.chat?.id ?? u.my_chat_member?.chat?.id;
    if (id) return String(id);
  }
  return undefined;
}
