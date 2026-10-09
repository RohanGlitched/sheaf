"use client";

/**
 * The browser's side of /api/panta. Every call resolves (never throws), so a
 * network failure or a non-JSON error page can never leave a button spinning.
 */

export type PantaMode = "live" | "sandbox" | "off";

export type PantaResult<T> = { ok: true; data: T & { fixture?: boolean; mode?: PantaMode } } | { ok: false; error: string };

async function read<T>(res: Response): Promise<PantaResult<T>> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {}
  const j = (body ?? {}) as { error?: string };
  if (!res.ok || j.error) {
    return { ok: false, error: j.error ?? (res.status === 429 ? "Too many requests; wait a moment." : `Panta did not answer (${res.status}).`) };
  }
  return { ok: true, data: body as T & { fixture?: boolean; mode?: PantaMode } };
}

export async function pantaPost<T>(payload: Record<string, unknown>): Promise<PantaResult<T>> {
  try {
    const res = await fetch("/api/panta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await read<T>(res);
  } catch {
    return { ok: false, error: "Could not reach Sheaf's server. Check the connection and try again." };
  }
}

export async function pantaGet<T>(path: string): Promise<PantaResult<T>> {
  try {
    return await read<T>(await fetch(path, { cache: "no-store" }));
  } catch {
    return { ok: false, error: "Could not reach Sheaf's server." };
  }
}

export const usdcBase = (base: string | number | undefined | null) =>
  base == null || base === "" ? "—" : (Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const short = (s: string | undefined | null, lead = 6, tail = 4) =>
  !s ? "—" : s.length <= lead + tail + 1 ? s : `${s.slice(0, lead)}…${s.slice(-tail)}`;
