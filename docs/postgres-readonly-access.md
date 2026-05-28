# Plan: Give Claude read-only Postgres access via `mrc --postgres` (socat-forwarded)

## Context

mrc's firewall blocks all host traffic except the clipboard and notify proxy ports (`init-firewall.sh:91-109`). You want Claude to reach your local Postgres.app as a read-only role **without editing `postgresql.conf` or `pg_hba.conf`** on the host.

The existing `clipboard-proxy.sh` and `notify-proxy.sh` already solve a structurally identical problem: a host-side socat listener bound to `127.0.0.1`, reached from the container via `host.docker.internal` through Colima's `vz` VM. We copy that pattern. A new `pg-proxy.sh` forwards a dynamically allocated port to `127.0.0.1:5432`. Postgres.app sees connections as originating from localhost, so its default `trust` auth lets them in — no server-side config changes needed.

Read-only is enforced by the `claude_ro` role's `SELECT`-only GRANTs. (Trust-auth caveat at the end.)

---

## Part A — Create the read-only role (host, ~30 seconds)

No config files touched. Just role + grants.

Generate a password:

```bash
openssl rand -base64 24
```

Open psql against Postgres.app (double-click the server row in Postgres.app, or `/Applications/Postgres.app/Contents/Versions/latest/bin/psql -d postgres`). Replace `<your_db>`:

```sql
CREATE ROLE claude_ro LOGIN PASSWORD '<paste-generated-password>';

\c <your_db>
GRANT CONNECT ON DATABASE <your_db> TO claude_ro;
GRANT USAGE  ON SCHEMA public TO claude_ro;
GRANT SELECT ON ALL TABLES    IN SCHEMA public TO claude_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;

-- Repeat USAGE + SELECT for any non-public schemas you use.
```

Sanity-check from the host:

```bash
psql "postgres://claude_ro:<pw>@localhost:5432/<your_db>" -c "SELECT current_user"
# expect: claude_ro
psql "postgres://claude_ro:<pw>@localhost:5432/<your_db>" -c "CREATE TABLE _probe (x int)"
# expect: ERROR: permission denied
```

---

## Part B — mrc code changes

### B1. New file `/workspace/pg-proxy.sh` — host-side TCP forwarder

Modeled after `clipboard-proxy.sh:142` and `notify-proxy.sh:63`. Pure TCP forward, no protocol layer:

```bash
#!/usr/bin/env bash
#
# pg-proxy.sh — Host-side Postgres proxy for mrc containers.
# Listens on 127.0.0.1:<port> and forwards to 127.0.0.1:5432.
# Lets the container reach host-local Postgres via host.docker.internal
# without modifying postgresql.conf or pg_hba.conf.
#
set -euo pipefail

PORT="${1:?usage: pg-proxy.sh <listen-port>}"
TARGET="${MRC_PG_TARGET:-127.0.0.1:5432}"

log() { echo "[pg-proxy] $(date +%H:%M:%S) $*" >&2; }
log "listening on 127.0.0.1:$PORT → $TARGET"

exec socat TCP-LISTEN:"$PORT",fork,reuseaddr,bind=127.0.0.1 TCP:"$TARGET"
```

Make it executable. `MRC_PG_TARGET` is an escape hatch if you ever need to forward to a non-default Postgres (e.g. `127.0.0.1:5433`). Default targets Postgres.app's default.

### B2. `Dockerfile` — install `psql`

Add one line to the apt-get block (`Dockerfile:4-18`):

```
    postgresql-client \
```

### B3. `mrc` — flag, port allocation, proxy startup, cleanup, banner

**Help text** (`mrc:13-16`): after the `--web` line:

```
#   -p, --postgres       Forward host Postgres (127.0.0.1:5432) into the container
```

**Flag default** (`mrc:126`):

```bash
ALLOW_POSTGRES=false
```

**Flag parse case** (`mrc:145`, after `--web|-w`):

```bash
    --postgres|-p) ALLOW_POSTGRES=true ;;
```

**Proxy startup** — insert after the notify-proxy block (`mrc:639`), before the banner cat-heredoc at line 641. Follows the clipboard/notify pattern exactly:

```bash
# Start Postgres proxy if --postgres flag is set
PG_PROXY_PORT=""
PG_PROXY_PID=""
if $ALLOW_POSTGRES; then
  if ! command -v socat &>/dev/null; then
    echo "  ! --postgres requires socat (brew install socat)"
  else
    PG_PROXY_PORT="$(find_free_port $((NOTIFY_PORT + 1)))"
    bash "$SCRIPT_DIR/pg-proxy.sh" "$PG_PROXY_PORT" 2>/dev/null &
    PG_PROXY_PID=$!
    for _ in $(seq 1 10); do
      if lsof -i :"$PG_PROXY_PORT" &>/dev/null 2>&1 || nc -z 127.0.0.1 "$PG_PROXY_PORT" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$PG_PROXY_PID" 2>/dev/null; then
      ENV_FLAGS+=(-e ALLOW_POSTGRES=1)
      ENV_FLAGS+=(-e "MRC_PG_PORT=$PG_PROXY_PORT")
      ENV_FLAGS+=(-e "PGHOST=host.docker.internal")
      ENV_FLAGS+=(-e "PGPORT=$PG_PROXY_PORT")
    else
      echo "  ! Postgres proxy failed to start"
      PG_PROXY_PID=""
    fi
  fi
fi
```

Setting `PGHOST` and `PGPORT` directly means `psql`, `pg_dump`, Prisma, Django, Rails — anything that uses libpq or respects libpq env vars — picks them up with no per-tool config. The user supplies `PGUSER`/`PGPASSWORD`/`PGDATABASE` via `.mrcrc` (Part C).

**Cleanup** (`mrc:445-453`, the `cleanup()` function): add one line:

```bash
[[ -n "${PG_PROXY_PID:-}" ]] && kill "$PG_PROXY_PID" 2>/dev/null || true
```

**Banner** (`mrc:669-673`): extend for the new state:

```bash
if $ALLOW_WEB && $ALLOW_POSTGRES; then
  echo "  → Firewall:  jammed, web + local postgres open (--web --postgres)"
elif $ALLOW_WEB; then
  echo "  → Firewall:  jammed, but he can see the web (--web)"
elif $ALLOW_POSTGRES; then
  echo "  → Firewall:  jammed, local postgres open (--postgres)"
else
  echo "  → Firewall:  jammed (just like their radar)"
fi
```

**Optional: container label** (`mrc:733`, alongside `mrc.web`):

```bash
  --label "mrc.postgres=$ALLOW_POSTGRES" \
```

### B4. `entrypoint.sh` — forward the port to the firewall

Edit `entrypoint.sh:21-24` to add `MRC_PG_PORT`:

```bash
sudo ALLOW_WEB="${ALLOW_WEB:-}" \
  MRC_CLIPBOARD_PORT="${MRC_CLIPBOARD_PORT:-7722}" \
  MRC_NOTIFY_PORT="${MRC_NOTIFY_PORT:-7723}" \
  MRC_PG_PORT="${MRC_PG_PORT:-}" \
  /usr/local/bin/init-firewall.sh
```

(`ALLOW_POSTGRES` itself isn't needed in the firewall anymore — if `MRC_PG_PORT` is empty, no rule is added.)

### B5. `init-firewall.sh` — add the proxy port to the allowed list

Edit the existing port-loop (`init-firewall.sh:93-98`) to include `MRC_PG_PORT` when set:

```bash
CLIP_PORT="${MRC_CLIPBOARD_PORT:-7722}"
NOTIFY_PORT="${MRC_NOTIFY_PORT:-7723}"
PG_PORT="${MRC_PG_PORT:-}"
PROXY_PORTS="$CLIP_PORT $NOTIFY_PORT"
[ -n "$PG_PORT" ] && PROXY_PORTS="$PROXY_PORTS $PG_PORT"
for port in $PROXY_PORTS; do
    iptables -A OUTPUT -d "$HOST_NETWORK" -p tcp --dport "$port" -j ACCEPT
    iptables -A INPUT  -s "$HOST_NETWORK" -p tcp --sport "$port" -j ACCEPT
done
```

And update the parallel loop for `HDINT_IP` at `init-firewall.sh:105-108` to iterate over the same `$PROXY_PORTS` variable.

Net effect: when `--postgres` is off, firewall is byte-identical to today. When on, exactly one extra port (the dynamic proxy port) is opened — not 5432, not any wildcard.

### B6. `README.md` — one short section

Add a "Local Postgres" section near "Letting him visit new places". Mention: what `--postgres` does, the `claude_ro` recipe (or link to `scripts/setup-claude-ro.sql` if you extract it), the `.mrcrc` shape, the trust-auth caveat.

---

## Part C — Wire up credentials per-repo

In the target repo, create/edit `<repo>/.mrcrc`:

```
--postgres
PGUSER=claude_ro
PGPASSWORD=<your-password>
PGDATABASE=<your_db>
```

`PGHOST` and `PGPORT` are set automatically by mrc — don't put them in `.mrcrc` (they'd be overwritten anyway).

Make sure `.mrcrc` is gitignored — it contains the password. Add it to `.gitignore` if missing.

Inside the container, `psql` / `pg_dump` / ORMs all honor `PG*` env vars natively:

```
psql -c "SELECT current_user, current_database()"
# no connection string needed — uses PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
```

If you want a composite `DATABASE_URL` (for Django/Rails/Prisma that prefer it), add:

```
DATABASE_URL=postgres://claude_ro:<pw>@host.docker.internal:${MRC_PG_PORT}/your_db
```

…but note `${MRC_PG_PORT}` is resolved inside the container at runtime, so you'd need to interpolate it via a shell snippet rather than a raw `.mrcrc` line. Simpler: stick with `PG*` vars.

---

## Files to modify / create

| File | Lines | Change |
|------|-------|--------|
| `/workspace/pg-proxy.sh` | (new) | socat forwarder, modeled on clipboard-proxy.sh |
| `/workspace/Dockerfile` | 4-18 | Add `postgresql-client` |
| `/workspace/mrc` | 13-16 | `--postgres` in help comment |
| `/workspace/mrc` | 126 | `ALLOW_POSTGRES=false` |
| `/workspace/mrc` | 145 | `--postgres\|-p` flag case |
| `/workspace/mrc` | 445-453 | kill `PG_PROXY_PID` in cleanup |
| `/workspace/mrc` | 639 | insert pg-proxy startup block |
| `/workspace/mrc` | 669-673 | extend firewall banner for 4 states |
| `/workspace/mrc` | 733 | optional `mrc.postgres` container label |
| `/workspace/entrypoint.sh` | 21-24 | forward `MRC_PG_PORT` to firewall sudo call |
| `/workspace/init-firewall.sh` | 93-108 | include `MRC_PG_PORT` in proxy-port loops |
| `/workspace/README.md` | (new section) | Document `--postgres` + role recipe |
| `<target-repo>/.mrcrc` | (you create) | `--postgres` + `PGUSER/PGPASSWORD/PGDATABASE` |
| `<target-repo>/.gitignore` | (verify) | Ensure `.mrcrc` is ignored |

---

## Verification

1. **Rebuild image** (Dockerfile changed): `docker rmi mister-claude`.
2. **Launch**: `mrc <repo>` — banner should say "local postgres open".
3. **Identity check inside the container:**
   ```
   psql -c "SELECT current_user, current_database()"
   ```
   Expect `claude_ro` / `<your_db>`.
4. **Read works:**
   ```
   psql -c "SELECT count(*) FROM <some_table>"
   ```
5. **Writes blocked:**
   ```
   psql -c "CREATE TABLE _probe (x int)"
   psql -c "UPDATE <some_table> SET id=id"
   ```
   Both must fail with `permission denied`.
6. **Firewall still blocks non-Postgres traffic:**
   ```
   curl -m 3 https://example.com     # times out
   psql -h 8.8.8.8 -U x postgres     # times out (not auth error — connection refused)
   ```
7. **Without `--postgres`** (remove from `.mrcrc`), `psql` must fail to reach the server — proves the flag gates access.
8. **`mrc status`** should show `postgres=true` on the session (if you added the label).

---

## Security note — trust-auth caveat

Postgres.app ships with `host all all all trust` in `pg_hba.conf`. From Postgres's perspective, the proxied connection *is* a localhost connection, so trust applies — meaning Postgres doesn't actually check the `claude_ro` password. That's fine in practice (Claude uses whatever `PGUSER` says), but it means the role boundary is a **convention inside the container**, not a hard server-side guarantee: a clever client could connect as your macOS username (superuser) instead.

If you want it to be a real enforcement boundary, add to `~/Library/Application Support/Postgres/var-<VER>/pg_hba.conf` *above* the catch-all trust line:

```
host    <your_db>    claude_ro    127.0.0.1/32    scram-sha-256
host    <your_db>    all          127.0.0.1/32    reject
```

…then `pg_ctl reload`. The role already has a password from Part A. This is the only situation where the plan requires a config-file edit — and only if you decide the trust-auth compromise isn't acceptable for your threat model.

Recommendation: ship without the pg_hba edit first. The layering (firewall → proxy → role conventions) is already stricter than your current baseline (any host process can hit 5432 as anyone). Tighten later if/when Claude starts chewing on more sensitive data.
