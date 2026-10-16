export interface SendOptions {
  url: string;
  route: string;
  data: string;
  recipients: string[];
  threadKey?: string;
  update?: boolean;
  apiKey: string;
  idempotencyKey?: string;
}

/** `notify send`: POST /v1/notify with an API key (for scripts and services). */
export async function send(options: SendOptions, fetchImpl: typeof fetch = fetch): Promise<string> {
  const data = parseObject(options.data || "{}");
  if (!data) throw new Error("--data must be a JSON object");
  const res = await fetchImpl(`${options.url.replace(/\/+$/, "")}/v1/notify`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      route: options.route,
      data,
      recipients: options.recipients,
      ...(options.threadKey ? { thread_key: options.threadKey } : {}),
      ...(options.update ? { update: true } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    notification_id?: string;
    message?: string;
    issues?: { path: string; message: string }[];
  };
  if (res.status !== 202) {
    const issues = body.issues?.map((i) => `${i.path || "(body)"}: ${i.message}`).join("; ");
    throw new Error(`HTTP ${res.status}: ${[body.message, issues].filter(Boolean).join(" — ")}`);
  }
  return body.notification_id!;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
