#!/usr/bin/env bash
# Deploy web/ to Vercel production and point sheaf-index.vercel.app at that exact build.
set -euo pipefail
cd "$(dirname "$0")/../web"
out=$(npx vercel --prod --yes 2>&1)
url=$(printf "%s" "$out" | grep -o "sheaf-[a-z0-9]*-rohanglitcheds-projects.vercel.app" | head -1)
[ -n "$url" ] || { printf "%s\n" "$out" | tail -20; exit 1; }
npx vercel alias set "$url" sheaf-index.vercel.app >/dev/null
echo "live: https://sheaf.world and https://sheaf-index.vercel.app -> $url"
