"use client";

import { useEffect, useState } from "react";
import { FX_FALLBACK, getInrRate, type Fx } from "@/lib/fx";

/**
 * The site's one rupee rate, in a client component. Starts from the dated
 * fallback so rupees show at once, then switches to the live rate (shared and
 * cached for an hour by lib/fx.ts). `ready` turns true once the read is done.
 */
export function useInrRate(): { fx: Fx; ready: boolean } {
  const [state, setState] = useState<{ fx: Fx; ready: boolean }>({ fx: FX_FALLBACK, ready: false });
  useEffect(() => {
    let live = true;
    void getInrRate().then((fx) => live && setState({ fx, ready: true }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}
