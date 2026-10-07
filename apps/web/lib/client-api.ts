"use client";

/** Browser-side mutation helper — same-origin /api proxy, uniform error shape. */
export async function clientApi<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<
  | { ok: true; data: T }
  // `status` is absent when no response arrived, so the outcome is unknown.
  | { ok: false; message: string; status?: number; code?: string }
> {
  try {
    const idempotencyKey =
      body && typeof body === "object" && "idempotency_key" in body
        ? String((body as { idempotency_key?: unknown }).idempotency_key ?? "")
        : "";
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = (await res.json().catch(() => null)) as
      | ({ error?: { code?: string; message?: string } } & T)
      | null;
    if (!res.ok) {
      return {
        ok: false,
        message: payload?.error?.message ?? `request failed (${res.status})`,
        status: res.status,
        code: payload?.error?.code,
      };
    }
    return { ok: true, data: payload as T };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "control plane unreachable",
    };
  }
}
