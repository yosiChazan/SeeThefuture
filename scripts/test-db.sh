#!/usr/bin/env bash
# Apply all migrations to a throwaway local Postgres and run the policy tests.
# Usage: scripts/test-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
TMP="$(mktemp -d)"
DATA="$TMP"
PORT="${PGPORT_TEST:-54329}"
SOCK="$DATA/sock"
mkdir -p "$SOCK"

cleanup() { "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$DATA"
  RUN=(runuser -u postgres --)
else
  RUN=()
fi

"${RUN[@]}" "$PG_BIN/initdb" -D "$DATA/db" -U postgres -A trust >/dev/null
"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$DATA/db" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w start >/dev/null
DATA="$DATA/db"

PSQL=(psql -h "$SOCK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$ROOT/supabase/tests/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
"${PSQL[@]}" -f "$ROOT/supabase/tests/access_control_test.sql"
