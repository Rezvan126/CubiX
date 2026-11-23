#!/usr/bin/env bash
# Fresh local DB + dev server on :8788 for the test suites.
cd "$(dirname "$0")/.."
pkill -f "wrangler pages dev" 2>/dev/null; sleep 1
rm -rf .wrangler/state && npx wrangler d1 execute cubix-db --local --file=schema.sql >/dev/null 2>&1
nohup npx wrangler pages dev --port 8788 > .wrangler/dev.log 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null localhost:8788/api/auth/me && break; sleep 0.5; done
echo "dev server ready on http://localhost:8788"
