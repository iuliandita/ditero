// ntfy adapter. Outbound push + an http action button that POSTs to our ack webhook.
export async function sendNtfy(opts: {
  server?: string;
  topic: string;
  title: string;
  message: string;
  ackUrl?: string;
  tags?: string[];
}): Promise<boolean> {
  const server = opts.server ?? process.env.NTFY_SERVER ?? "https://ntfy.sh";
  const headers: Record<string, string> = { Title: opts.title };
  if (opts.tags?.length) headers.Tags = opts.tags.join(",");
  // Action button: tapping it POSTs to ackUrl and clears the notification.
  if (opts.ackUrl) headers.Actions = `http, Done, ${opts.ackUrl}, method=POST, clear=true`;
  try {
    const res = await fetch(`${server}/${opts.topic}`, {
      method: "POST",
      headers,
      body: opts.message,
    });
    return res.ok;
  } catch {
    return false;
  }
}
