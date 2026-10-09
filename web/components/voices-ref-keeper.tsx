"use client";

import { useEffect } from "react";
import { currentRef } from "@/lib/invite-keep";

/**
 * Keeps an invite code (?ref=) from whichever page someone lands on, so it is
 * still there when they reach /voices or the waitlist. Renders nothing. Mount it
 * once in the root layout; it stores only the code, in localStorage, for 30 days.
 */
export function VoicesRefKeeper() {
  useEffect(() => {
    currentRef();
  }, []);
  return null;
}
