import "server-only";
import type { GithubProof } from "./voices-message";

/**
 * Proof that a GitHub handle on /voices belongs to the person who signed: they
 * publish the exact signed message as a public gist from that account. The
 * server reads the gist from GitHub's API and checks that its owner is the handle
 * and that one of its files contains the message, character for character
 * (line endings aside). X and Telegram have no such check and stay self-reported.
 */

/** A gist id from a gist URL or a bare id, or null. */
export function gistId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length > 200) return null;
  const m = /^(?:https?:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]{1,39}\/)?)?([0-9a-f]{20,40})(?:[/#?].*)?$/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

type Gist = { owner?: { login?: string } | null; public?: boolean; files?: Record<string, { content?: string; truncated?: boolean }> };

const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();

export type GithubCheck = { ok: true; proof: GithubProof } | { ok: false; error: string };

export async function checkGist(id: string, handle: string, message: string): Promise<GithubCheck> {
  let r: Response;
  try {
    r = await fetch(`https://api.github.com/gists/${id}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sheaf-voices", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: "GitHub didn't answer. Try again in a minute." };
  }
  if (r.status === 404) return { ok: false, error: "No public gist with that id." };
  if (r.status === 403 || r.status === 429) return { ok: false, error: "GitHub is limiting requests just now. Try again later." };
  if (!r.ok) return { ok: false, error: "GitHub didn't answer. Try again in a minute." };
  const gist = (await r.json().catch(() => null)) as Gist | null;
  const login = gist?.owner?.login;
  if (!login || login.toLowerCase() !== handle.toLowerCase()) return { ok: false, error: `That gist belongs to ${login ? `@${login}` : "nobody"}, not ${handle}.` };
  if (gist.public === false) return { ok: false, error: "Make the gist public (secret gists can't be checked by others)." };
  const want = norm(message);
  const found = Object.values(gist.files ?? {}).some((f) => !f.truncated && typeof f.content === "string" && norm(f.content).includes(want));
  if (!found) return { ok: false, error: "The gist doesn't contain the exact message you signed. Copy it again with the button." };
  return { ok: true, proof: { gist: id, login, at: new Date().toISOString() } };
}
