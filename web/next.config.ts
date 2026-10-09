import type { NextConfig } from "next";

/**
 * Security headers on every response. The page signs with a one-click browser
 * wallet, so no other site may frame it (clickjacking): frame-ancestors 'none'
 * and X-Frame-Options DENY say the same thing to new and old browsers. The rest
 * of the policy is deliberately narrow (no plugins, no base-tag hijack, forms only
 * to this site) so it cannot break the RPC, wallet, font, price, Solami, Panta or
 * EVM calls the pages make; scripts and connections are not restricted here.
 */
const CSP = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join("; ");

const nextConfig: NextConfig = {
  // The project lives on a Windows drive mounted into WSL, where inotify events
  // never fire, so file changes are invisible to the watcher without polling.
  // Remove this when the repository sits on a native Linux filesystem.
  watchOptions: { pollIntervalMs: 1000 },
  turbopack: { root: __dirname },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
