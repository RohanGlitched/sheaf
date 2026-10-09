"use client";

import { useEffect, useState } from "react";
import { cleanRef, REF_PARAM } from "./invite-ref";

/**
 * The invite code that brought this browser here, if any.
 *
 * Read from ?ref= on whatever page the person landed on, and kept in this
 * browser's localStorage for 30 days so it survives a visit to a basket and back
 * before they sign. That one short code is the only thing kept: no cookie, no id,
 * nothing sent anywhere until the person submits a form that carries it.
 * A newer ?ref= replaces an older one.
 */

const KEY = "sheaf.ref";
const TTL_MS = 30 * 24 * 3600_000;

function readStored(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const { ref, at } = JSON.parse(raw) as { ref?: unknown; at?: unknown };
    if (typeof at !== "number" || Date.now() - at > TTL_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return cleanRef(ref);
  } catch {
    return null;
  }
}

function store(ref: string) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ref, at: Date.now() }));
  } catch {
    /* private window or blocked storage: the code still works from the URL */
  }
}

/** Reads ?ref= now (and keeps it), else the kept code. Safe to call anywhere in the browser. */
export function currentRef(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = cleanRef(new URLSearchParams(window.location.search).get(REF_PARAM));
  if (fromUrl) {
    store(fromUrl);
    return fromUrl;
  }
  return readStored();
}

/** Forgets the kept code, for a "not from this link" control. */
export function forgetRef() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}

/** The invite code for this visit, or null; null on the server and on first paint. */
export function useInviteRef(): [string | null, (ref: string | null) => void] {
  const [ref, setRef] = useState<string | null>(null);
  useEffect(() => {
    // Deferred so the first client render matches the server's.
    void Promise.resolve().then(() => setRef(currentRef()));
  }, []);
  const set = (next: string | null) => {
    if (next) store(next);
    else forgetRef();
    setRef(next);
  };
  return [ref, set];
}
