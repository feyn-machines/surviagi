"""The server side of the data release line: set up the database, connect to it over SSH.

Nothing here stores or prints a password. The passwords are generated on the server by
`setup_script`; a data release reads the writer's one from the server into memory and
uses it through an SSH forward to the database's loopback port.

No psycopg import at module level: the pure builders are unit-tested with the system python.
"""
from __future__ import annotations

import contextlib
import re
import socket
import subprocess
import time
from pathlib import Path

import site_release as site
from site_release import PRODUCTION, ReleaseError

ROOT = site.ROOT
DEPLOY_DB = ROOT / "deploy" / "db"
SCHEMA_SQL = ROOT / "db" / "published" / "001_kg.sql"
APP_SQL_DIR = ROOT / "db" / "app"
APP_FILE_NAME = re.compile(r"[0-9]{3}_[a-z_]+\.sql")

DB_PORT = 5434
DB_NAME = "openaiwill"
WRITER = "oaw_kg_writer"
SITE_ROLE = "oaw_site"
APP_ROLE = "oaw_app"
APP_BACKUPS = "backups"
PASSWORD_PATTERN = re.compile(r"[0-9A-Za-z]{32,}")
WATCH_SECONDS = 60


def parse_env(text: str) -> dict[str, str]:
    """KEY=VALUE lines of an env file; blank lines and # comments are skipped."""
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def first_line(error: Exception) -> str:
    """One line of an error for the terminal: a database error's DETAIL lines can quote row values."""
    text = str(error).strip()
    return text.splitlines()[0] if text else type(error).__name__


def checked_password(value: str, key: str = "OAW_KG_WRITER_PASSWORD") -> str:
    """A password read from the server. A malformed one is refused without echoing any value."""
    value = value.strip()
    if not PASSWORD_PATTERN.fullmatch(value):
        raise ReleaseError(f"db.env on the server has no usable {key}; run `pnpm db:setup` first")
    return value


def writer_password(env_text: str) -> str:
    """The data writer's password from the text of db.env."""
    return checked_password(parse_env(env_text).get("OAW_KG_WRITER_PASSWORD", ""))


def db_forward_argv(target: dict, local_port: int) -> list[str]:
    """ssh command forwarding a local port to the server database's loopback port."""
    return site.forward_argv(target, local_port, DB_PORT)


def heredoc(path: str, text: str, tag: str) -> str:
    """Shell that writes `text` to `path` byte for byte (quoted here-document)."""
    if not re.fullmatch(r"[A-Z_]+", tag):
        raise ValueError("bad here-document tag")
    if tag in text.splitlines():
        raise ReleaseError(f"{tag} occurs in the text being uploaded")
    return f"cat > {path} <<'{tag}'\n{text if text.endswith(chr(10)) else text + chr(10)}{tag}\n"


def app_sql_files() -> dict[str, str]:
    """db/app/*.sql by file name, in the order they are applied."""
    return {path.name: path.read_text() for path in sorted(APP_SQL_DIR.glob("*.sql"))}


def setup_script(target: dict, compose_text: str, roles_sql: str, schema_sql: str, grants_sql: str,
                 app_sql: dict[str, str]) -> str:
    """The one script `pnpm db:setup` runs on the server (sent on stdin). Repeatable.

    Passwords are generated here, only when db.env does not exist, written with umask 077, and
    handed to psql through `docker exec --env-file` so they never appear on a command line.

    Recovery from a lost db.env while the database volume exists: delete site.env too and run this again.
    Everything here reaches PostgreSQL as the superuser through the container's local socket (trusted, no
    password), and roles.sql then sets all three role passwords, the superuser's included, to the newly
    generated ones. No step needs the old superuser password, and no data is touched.
    Schema app (user data) belongs to oaw_app, whose password is added to an older db.env, and whose settings
    (APP_DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL) are added to site.env only when absent; the Google
    values are uploaded separately by `pnpm site:env`. Existing keys are never rewritten, except that
    APP_DATABASE_URL follows db.env's app password.
    Every command that could read the script from stdin has its own redirect."""
    root = site.rpath(target)
    db = site.rpath(target, "db")
    env_file = site.rpath(target, "db", "db.env")
    site_env = site.site_env_file(target)
    backups = site.rpath(target, APP_BACKUPS)
    for name in app_sql:
        if not APP_FILE_NAME.fullmatch(name):
            raise ReleaseError(f"unexpected file name in db/app: {name}")

    def put(name: str, text: str, tag: str) -> str:
        return heredoc(site.rpath(target, "db", name), text, tag)

    psql = f"sudo docker exec -i --env-file {env_file} openaiwill-db psql -X -q -v ON_ERROR_STOP=1"
    # The stock image trusts 127.0.0.1 and the socket, so the passwords are only enforced on the container's own
    # network address: that is where the checks connect, with the password taken from the env file inside the
    # container (never on a command line).
    address = 'ip=$(hostname -i); ip=${{ip%% *}}; '  # doubled braces: str.format below
    check = ('sudo docker exec -i --env-file {env} openaiwill-db sh -c '
             "'" + address + 'PGPASSWORD="{password}" psql -X -h "$ip" -U {role} -d {db} -tAc "{sql}"\' </dev/null')
    app_puts = "".join(put(name, text, f"OPENAIWILL_APP_{chr(65 + index)}_EOF") for index, (name, text) in enumerate(app_sql.items()))
    app_apply = "".join(f"{psql} -U {APP_ROLE} -d {DB_NAME} < {name}\n" for name in app_sql)
    wrong = check.format(env="db.env", password="not-the-password", role=SITE_ROLE, db=DB_NAME, sql="SELECT 1")
    return f"""umask 077
endnl() {{ [ -z "$(tail -c1 "$1")" ] || echo >> "$1"; }}
if [ -f {env_file} ]; then
  for k in POSTGRES_PASSWORD OAW_KG_WRITER_PASSWORD OAW_SITE_PASSWORD OAW_APP_PASSWORD; do
    v=$(sed -n "s/^$k=//p" {env_file})
    # A db.env from before the app role has no OAW_APP_PASSWORD line, and gets one below. A line that is
    # present but empty is an unusable password, not a missing one.
    if [ "$k" = OAW_APP_PASSWORD ] && ! grep -q '^OAW_APP_PASSWORD=' {env_file}; then continue; fi
    if [ "$(printf '%s\\n' "$v" | wc -l)" -ne 1 ] || ! printf '%s' "$v" | grep -Eq '^[0-9a-f]{{48}}$'; then
      echo "db.env has an unusable $k; nothing was changed" >&2; exit 1
    fi
  done
fi
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" {root} {db} </dev/null
sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" {backups} </dev/null
sudo docker network inspect openaiwill >/dev/null 2>&1 </dev/null || sudo docker network create openaiwill >/dev/null </dev/null
newpw() {{ local p; p=$(openssl rand -hex 24); [ "${{#p}}" -eq 48 ] || {{ echo 'could not generate a password' >&2; exit 1; }}; echo "$p"; }}
newsecret() {{ local p; p=$(openssl rand -hex 32); [ "${{#p}}" -eq 64 ] || {{ echo 'could not generate a secret' >&2; exit 1; }}; echo "$p"; }}
if [ ! -f {env_file} ]; then
  if [ -f {site_env} ]; then echo 'site.env exists but db/db.env does not; refusing to invent new passwords' >&2; exit 1; fi
  a=$(newpw); b=$(newpw); c=$(newpw); d=$(newpw)
  printf 'POSTGRES_PASSWORD=%s\\nOAW_KG_WRITER_PASSWORD=%s\\nOAW_SITE_PASSWORD=%s\\nOAW_APP_PASSWORD=%s\\n' "$a" "$b" "$c" "$d" > {env_file}
  echo 'generated the database passwords on the server'
fi
if ! grep -q '^OAW_APP_PASSWORD=' {env_file}; then
  endnl {env_file}
  e=$(newpw)
  printf 'OAW_APP_PASSWORD=%s\\n' "$e" >> {env_file}
  echo 'added the app password to db.env'
fi
chmod 600 {env_file}
if [ ! -f {site_env} ]; then
  pw=$(sed -n 's/^OAW_SITE_PASSWORD=//p' {env_file})
  [ -n "$pw" ] || {{ echo 'db.env has no OAW_SITE_PASSWORD' >&2; exit 1; }}
  printf 'DATABASE_URL=postgres://{SITE_ROLE}:%s@openaiwill-db:5432/{DB_NAME}\\n' "$pw" > {site_env}
  echo 'wrote site.env'
fi
endnl {site_env}
apw=$(sed -n 's/^OAW_APP_PASSWORD=//p' {env_file})
[ -n "$apw" ] || {{ echo 'db.env has no OAW_APP_PASSWORD' >&2; exit 1; }}
want="postgres://{APP_ROLE}:${{apw}}@openaiwill-db:5432/{DB_NAME}"
cur=$(sed -n 's/^APP_DATABASE_URL=//p' {site_env})
if [ -z "$cur" ]; then
  printf 'APP_DATABASE_URL=%s\\n' "$want" >> {site_env}
  echo 'added APP_DATABASE_URL to site.env'
elif [ "$cur" != "$want" ]; then
  tmp=$(mktemp {site_env}.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  grep -v '^APP_DATABASE_URL=' {site_env} > "$tmp" || [ $? -eq 1 ]
  printf 'APP_DATABASE_URL=%s\\n' "$want" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" {site_env}
  echo 'updated APP_DATABASE_URL in site.env to follow db.env'
fi
if ! grep -q '^BETTER_AUTH_SECRET=' {site_env}; then
  secret=$(newsecret)
  printf 'BETTER_AUTH_SECRET=%s\\n' "$secret" >> {site_env}
  echo 'added BETTER_AUTH_SECRET to site.env'
fi
if ! grep -q '^BETTER_AUTH_URL=' {site_env}; then
  printf 'BETTER_AUTH_URL={site.SITE_URL}\\n' >> {site_env}
  echo 'added BETTER_AUTH_URL to site.env'
fi
chmod 600 {site_env}
{put('compose.yml', compose_text, 'OPENAIWILL_COMPOSE_EOF')}{put('roles.sql', roles_sql, 'OPENAIWILL_ROLES_EOF')}{put('001_kg.sql', schema_sql, 'OPENAIWILL_SCHEMA_EOF')}{put('grants.sql', grants_sql, 'OPENAIWILL_GRANTS_EOF')}{app_puts}cd {db}
sudo docker compose -p openaiwill-db --env-file db.env up -d --wait --wait-timeout 180 </dev/null
{psql} -U postgres -d postgres < roles.sql
{psql} -U {WRITER} -d {DB_NAME} < 001_kg.sql
{psql} -U {WRITER} -d {DB_NAME} < grants.sql
{app_apply}{check.format(env='db.env', password='$OAW_KG_WRITER_PASSWORD', role=WRITER, db=DB_NAME, sql='SELECT count(*) FROM kg.releases')} >/dev/null
n=$({check.format(env='db.env', password='$OAW_SITE_PASSWORD', role=SITE_ROLE, db=DB_NAME, sql='SELECT count(*) FROM kg.releases')})
if {wrong} >/dev/null 2>&1; then echo 'password authentication is not being enforced on the container network' >&2; exit 1; fi
{check.format(env='db.env', password='$OAW_APP_PASSWORD', role=APP_ROLE, db=DB_NAME, sql='SELECT count(*) FROM app.submissions')} >/dev/null
viol=$({psql} -U postgres -d {DB_NAME} -tA -c "SELECT r || ' ' || s FROM (VALUES ('oaw_app','kg','USAGE'),('oaw_site','app','USAGE'),('oaw_kg_writer','app','USAGE'),('oaw_app','public','CREATE')) AS t(r,s,p) WHERE has_schema_privilege(r,s,p)" </dev/null)
if [ -n "$viol" ]; then echo "isolation broken: $(printf '%s' "$viol" | tr '\\n' ',')" >&2; exit 1; fi
echo "the three roles authenticate with their passwords over the container network, a wrong password is refused and neither the app role nor the site role reaches the other's schema; releases in kg: $n"
sudo docker compose -p openaiwill-db --env-file db.env restart backup </dev/null
echo 'database ready (127.0.0.1:{DB_PORT} on the server, network openaiwill)'
"""


def port_probe_script(port: int) -> str:
    """Prints `listening` or `none`: whether something accepts connections on the server's loopback port."""
    return (f"if (exec 3<>/dev/tcp/127.0.0.1/{int(port)}) 2>/dev/null; then echo listening; else echo none; fi")


def remote_stdin(target: dict, script: str) -> None:
    """Run a script on the server by sending it on stdin; its output is shown as it comes."""
    site.remote_stdin(target, script)


def setup_db() -> None:
    target = site.load_target()
    script = setup_script(target, (DEPLOY_DB / "compose.yml").read_text(), (DEPLOY_DB / "roles.sql").read_text(),
                          SCHEMA_SQL.read_text(), (DEPLOY_DB / "grants.sql").read_text(), app_sql_files())
    remote_stdin(target, script)
    sync_server_admins()


def sync_server_admins() -> None:
    """Make app.admins on the server equal to ADMIN_EMAILS in the local .env. Counts only are printed; an empty
    list is a warning, not a failure (the table keeps what it has)."""
    import app_db

    emails = app_db.read_admin_emails()
    if not emails:
        print("warning: ADMIN_EMAILS is empty in the local .env; the administrator list on the server was left unchanged")
        return
    with server_connection(APP_ROLE) as conn:
        added, removed = app_db.sync_admins(conn, emails)
    print(f"administrators on the server: {len(emails)} on the list (+{added}, -{removed})")


def read_writer_password(target: dict) -> str:
    try:
        # Only the writer's value is fetched, and without sudo: the deploy user owns the file (mode 600).
        value = site.remote(target, f"sed -n 's/^OAW_KG_WRITER_PASSWORD=//p' {site.rpath(target, 'db', 'db.env')}",
                            capture=True)
    except subprocess.CalledProcessError as error:
        raise ReleaseError(f"could not read the database credentials on the server (status {error.returncode}); "
                           "has `pnpm db:setup` run?") from None
    return checked_password(value)


def read_app_password(target: dict) -> str:
    try:
        value = site.remote(target, f"sed -n 's/^OAW_APP_PASSWORD=//p' {site.rpath(target, 'db', 'db.env')}", capture=True)
    except subprocess.CalledProcessError as error:
        raise ReleaseError(f"could not read the database credentials on the server (status {error.returncode}); "
                           "has `pnpm db:setup` run?") from None
    return checked_password(value, "OAW_APP_PASSWORD")


def wait_for_listener(port: int, process: subprocess.Popen, seconds: float = 15) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ReleaseError(f"the SSH forward exited with status {process.returncode}")
        with socket.socket() as probe:
            probe.settimeout(1)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.3)
    raise ReleaseError("the SSH forward to the server database did not open")


# A session whose client is gone (an SSH forward that dropped mid-release) keeps its transaction open, and
# the release lock with it, until the server notices: on 2026-10-16 the retry waited 26 minutes behind one.
# Such a session is ended after IDLE_IN_TRANSACTION, and a wait for a lock gives up after LOCK_WAIT so the
# caller can retry rather than hang.
IDLE_IN_TRANSACTION = "10min"
LOCK_WAIT = "15min"


def session_options(role: str) -> str:
    """Server settings for a session of `role`. The writer works in public; oaw_app's own search_path (app)
    is set on the role by roles.sql."""
    return ("-c timezone=UTC"
            f" -c idle_in_transaction_session_timeout={IDLE_IN_TRANSACTION} -c lock_timeout={LOCK_WAIT}"
            + (" -c search_path=public" if role == WRITER else ""))


@contextlib.contextmanager
def server_connection(role: str = WRITER):
    """A psycopg connection to the server database as the data writer (default) or as oaw_app, through an SSH
    forward that is always closed. The password lives in this process's memory only."""
    import psycopg
    from psycopg.rows import dict_row

    if role not in (WRITER, APP_ROLE):
        raise ValueError("unknown database role")
    target = site.load_target()
    password = read_writer_password(target) if role == WRITER else read_app_password(target)
    options = session_options(role)
    port = site.free_port()
    forward = subprocess.Popen(db_forward_argv(target, port), stdin=subprocess.DEVNULL)
    try:
        wait_for_listener(port, forward)
        conn = psycopg.connect(host="127.0.0.1", port=port, dbname=DB_NAME, user=role, password=password,
                               autocommit=True, row_factory=dict_row, connect_timeout=10,
                               application_name="openaiwill-data-release" if role == WRITER else "openaiwill-app-admin",
                               options=options)
        try:
            yield conn
        finally:
            conn.close()
    finally:
        forward.terminate()
        forward.wait()


def poll_release(read_body, expected: str, seconds: float = WATCH_SECONDS, interval: float = 3,
                 sleep=time.sleep, clock=time.monotonic) -> tuple[bool, str]:
    """Poll until the site reports data release `expected`. read_body() returns the /healthz body or raises
    ReleaseError. Returns (matched, the release last reported, or '' when it never answered)."""
    deadline = clock() + seconds
    last = ""
    while True:
        try:
            last = site.health_data(read_body()).get("releaseId") or ""
        except ReleaseError:
            pass
        if last == expected:
            return True, last
        if clock() >= deadline:
            return False, last
        sleep(interval)


def report_production(expected: str | None = None) -> bool:
    """Say what the production site serves. With `expected`, wait up to 60 s for it to serve that release,
    and return whether it does. Never fails the command: the database change has already been made."""
    try:
        return _report_production(expected)
    except (ReleaseError, subprocess.SubprocessError, OSError) as error:
        print(f"could not check the production site ({' '.join(str(error).split())}); the database change is done")
        return False


def _report_production(expected: str | None) -> bool:
    target = site.load_target()
    probe = site.remote(target, port_probe_script(PRODUCTION["port"]), capture=True)
    if probe != "listening":
        print("no production site is running yet")
        return False
    port = site.free_port()
    forward = subprocess.Popen(site.forward_argv(target, port, PRODUCTION["port"]), stdin=subprocess.DEVNULL)
    try:
        wait_for_listener(port, forward)
        base = f"http://127.0.0.1:{port}"
        read_body = lambda: site.fetch(base + "/healthz")[2]  # noqa: E731
        if expected is None:
            print(f"production site: {site.describe_health(read_body())}")
            return False
        matched, last = poll_release(read_body, expected)
        if matched:
            print(f"production site now serves data release {expected}")
        else:
            print(f"WARNING: production site still reports data release {last or 'none'} after {WATCH_SECONDS} s "
                  "(it re-checks every 30 s); run `pnpm site:status` to look again")
        return matched
    except ReleaseError as error:
        print(f"could not read the production site: {error}")
        return False
    finally:
        forward.terminate()
        forward.wait()
