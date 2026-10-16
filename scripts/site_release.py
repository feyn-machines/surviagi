#!/usr/bin/env python3
"""Build the site locally and ship the code to the server over SSH (the code release line).

  build     build, assemble .release/<id>/ and smoke-test it locally
  release   build, upload, and start the release as the candidate on the server
  promote   make the candidate the production service
  rollback  make the previous production release the production service again
  status    show what the server is running: each slot's code release and the data release it serves
  indexnow  tell IndexNow-fed search engines every address in the sitemap (promote does this too;
            `pnpm data:promote` sends only the addresses that are new, changed or gone)
  env       upload GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the local .env to the server's site.env

A code release contains no data. The site reads the active data release from the server
database (published separately with `pnpm data:release` and `pnpm data:promote`), so the
candidate can only start on a server that already holds one.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import http.client
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SNAPSHOT = ROOT / "datasets" / "published" / "latest"
STAGING = ROOT / ".release"
SITE_URL = "https://surviagi.com"
PRODUCTION = {"project": "openaiwill", "port": 8320, "env": "production"}
CANDIDATE = {"project": "openaiwill-next", "port": 8321, "env": "preview"}
LOCAL_PORT = 8399
KEEP = 5
RELEASE_ID = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{7,40}(-dirty)?")
USER_AGENT = f"surviagi-release/1.0 (+{SITE_URL})"
# The sitemap as IndexNow last accepted it: the baseline a data release is compared with (local, ignored).
INDEXNOW_STATE = ROOT / "data" / "indexnow" / "sitemap.json"
INDEXNOW_BATCH = 10_000  # the protocol's limit per request


class ReleaseError(Exception):
    pass


def release_id(built_at: datetime, commit: str, dirty: bool) -> str:
    """`<UTC build time>-<git short sha>[-dirty]`: a code release is named by when and from what it was built."""
    moment = built_at.astimezone(timezone.utc)
    return f"{moment:%Y%m%dT%H%M%SZ}-{commit}{'-dirty' if dirty else ''}"


def checked_id(value: str) -> str:
    """Every id that comes from the server, or goes into a remote command, passes through here."""
    value = value.strip()
    if not RELEASE_ID.fullmatch(value):
        raise ReleaseError(f"not a release id: {value!r}")
    return value


def valid_ids(names: list[str]) -> list[str]:
    return [name for name in names if RELEASE_ID.fullmatch(name)]


FORBIDDEN_DIRS = {"datasets", "data", "local", "docs", "design", "db", "scripts", ".git", ".claude", ".agents", ".codex"}
FORBIDDEN_NAME = re.compile(r"^\.env|\.pem$|\.key$|\.sqlite3?$|\.db$|cookies|storage[-_]state|^credentials", re.I)


def forbidden_entries(release_dir: Path) -> list[str]:
    """Paths that must never be uploaded. The release is assembled from an allow-list; this is the second check."""
    found = []
    for path in sorted(release_dir.rglob("*")):
        relative = path.relative_to(release_dir)
        parts = relative.parts
        if "node_modules" in parts:
            continue
        # `app/<dir>/...`: a private directory copied next to the server.
        private_dir = len(parts) > 1 and parts[0] == "app" and parts[1] in FORBIDDEN_DIRS
        if path.is_file() and (private_dir or FORBIDDEN_NAME.search(path.name)):
            found.append(str(relative))
    return found


def foreign_binaries(release_dir: Path) -> list[str]:
    """Image-optimizer packages. Their native binaries are built for this machine, not the server's."""
    found = []
    for directory, names, _ in os.walk(release_dir):
        for name in list(names):
            if name in ("sharp", "@img") or name.startswith(("@img+", "sharp-")):
                found.append(str((Path(directory) / name).relative_to(release_dir)))
                names.remove(name)
    return sorted(found)


def to_prune(ids: list[str], keep: int, protected: set[str]) -> list[str]:
    ids = valid_ids(ids)
    old = sorted(ids)[:-keep] if len(ids) > keep else []
    return [name for name in old if name not in protected]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url: str, cookie: str | None = None, headers: dict | None = None):
    opener = urllib.request.build_opener(NoRedirect)
    sent = {"User-Agent": USER_AGENT, **(headers or {}), **({"Cookie": cookie} if cookie else {})}
    request = urllib.request.Request(url, headers=sent)
    try:
        with opener.open(request, timeout=15) as response:
            return response.status, response.headers, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
        raise ReleaseError(f"{url}: no answer ({error})") from error


def indexnow_key() -> str | None:
    """The IndexNow key, discovered from the key file in public/ (a 32-hex name holding itself)."""
    for path in sorted((ROOT / "public").glob("*.txt")):
        if re.fullmatch(r"[0-9a-f]{32}", path.stem) and path.read_text().strip() == path.stem:
            return path.stem
    return None


# What the router sends on a client-side navigation. Next answers an RSC request with a 307 unless `_rsc`
# carries the hash of these headers, so the request is built the way the client builds it.
RSC_STATE_TREE = "%5B%22%22%2C%7B%7D%5D"


def rsc_request(path: str) -> tuple[str, dict]:
    digest = hashlib.sha256(",".join(["0", "0", RSC_STATE_TREE, "0"]).encode()).digest()[:12]
    param = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return f"{path}?_rsc={param}", {"RSC": "1", "Sec-Fetch-Dest": "empty", "Next-Router-State-Tree": RSC_STATE_TREE}


def is_reachability(failure: str) -> bool:
    return "is not reachable" in failure or ": no answer (" in failure


# One real page of each kind, taken from the sitemap. Occupation addresses contain a dot
# (the group pages /occupations/g/11 do not), so each of those is requested on its own.
DETAIL_PAGES = {
    "market": r"/markets/[^<]+",
    "dotted occupation": r"/occupations/\d[^<]*\.[^<]+",
    "occupation group": r"/occupations/g/[^<]+",
    "update": r"/updates/[^<]+",
    "work": r"/work/[^<]+",
    "Chinese dotted occupation": r"/zh-CN/occupations/\d[^<]*\.[^<]+",
}


def detail_patterns(with_data: bool) -> dict[str, str]:
    """The detail pages a smoke run asks the sitemap for. Without data there are none to ask for."""
    return dict(DETAIL_PAGES) if with_data else {}


def smoke(base: str, release: str | None, with_data: bool = True) -> list[str]:
    """Requests a reader or a crawler would make. Returns the failures.

    `with_data=False` is the subset that needs no data: fixed pages, redirects, 404s, robots, llms.txt."""
    failures = []
    try:
        fetch(base + "/healthz")
    except ReleaseError as error:
        return [f"{base} is not reachable: {error}"]

    def expect(path, status, location=None, contains=None, cookie=None, headers=None):
        try:
            code, headers, body = fetch(base + path, cookie, headers)
        except ReleaseError as error:
            failures.append(f"{path}: {error}")
            return ""
        where = headers.get("Location")
        if code != status:
            failures.append(f"{path}: status {code}, expected {status}")
        if location is not None and where != location:
            failures.append(f"{path}: Location {where!r}, expected {location!r}")
        if contains is not None and contains not in body:
            failures.append(f"{path}: body lacks {contains!r}")
        return body

    health = expect("/healthz", 200)
    if release and release not in health:
        failures.append(f"/healthz does not report {release}")
    expect("/", 200, contains='lang="en"')
    expect("/zh-CN", 200, contains='lang="zh-CN"')
    expect("/markets", 200, contains='lang="en"')
    expect("/zh-CN/occupations", 200, contains='lang="zh-CN"')
    expect("/robots.txt", 200, contains="Sitemap:")
    expect("/llms.txt", 200, contains="# SurviAGI")
    expect("/og/en.png", 200)
    key = indexnow_key()
    if key and expect(f"/{key}.txt", 200).strip() != key:
        failures.append(f"/{key}.txt: body is not the key")
    sitemap = expect("/sitemap.xml", 200, contains="<urlset")
    # Redirects are relative: the origin is behind a tunnel and must not name a scheme or host.
    expect("/markets?lang=zh-CN", 307, location="/zh-CN/markets")
    expect("/zh-CN/markets?lang=en", 307, location="/markets")
    expect("/en/markets", 308, location="/markets")
    expect("/ZH-cn/markets", 308, location="/zh-CN/markets")
    expect("/markets", 307, location="/zh-CN/markets", cookie="openaiwill_language=zh-CN")
    # A client-side navigation asks for the page it is already on; a redirect there breaks the language switch.
    rsc_path, rsc_headers = rsc_request("/markets")
    expect(rsc_path, 200, cookie="openaiwill_language=zh-CN", headers=rsc_headers)
    # The proxy's internal marker must not be forgeable by a client.
    forged = {"x-openaiwill-rewritten": "1"}
    expect("/en/markets", 308, location="/markets", headers=forged)
    expect("/markets", 200, headers=forged)
    expect("/markets/no-such-market", 404)
    expect("/zh-CN/updates/no-such-update", 404)
    expect("/no-such-page", 404)
    for legal in ("/privacy", "/zh-CN/privacy", "/terms", "/zh-CN/terms"):
        expect(legal, 200)
    # The admin page answers 404 to anyone who is not a signed-in administrator.
    expect("/admin", 404)
    # The session endpoint is outside the language rules and always says whether sign-in is on.
    me = expect("/api/me", 200)
    try:
        enabled_reported = "enabled" in json.loads(me)
    except (ValueError, TypeError):
        enabled_reported = False
    if not enabled_reported:
        failures.append("/api/me: body is not JSON with an 'enabled' key")
    for label, pattern in detail_patterns(with_data).items():
        match = re.search(rf"<loc>{re.escape(SITE_URL)}({pattern})</loc>", sitemap)
        if match:
            expect(match.group(1), 200)
        else:
            failures.append(f"sitemap lists no {label} page")
    return failures


def indexability(base: str, indexable: bool) -> list[str]:
    """Production must not send X-Robots-Tag; every other environment must send noindex."""
    try:
        code, headers, _ = fetch(base + "/markets")
    except ReleaseError as error:
        return [f"/markets: {error}"]
    header = headers.get("X-Robots-Tag")
    if code != 200:
        return [f"/markets: status {code}, expected 200"]
    if indexable and header:
        return [f"/markets sends X-Robots-Tag: {header}; production must be indexable"]
    if not indexable and header != "noindex":
        return [f"/markets sends X-Robots-Tag {header!r}; a non-production server must send noindex"]
    return []


def wait_until_answering(base: str, process: subprocess.Popen) -> None:
    for _ in range(30):
        if process.poll() is not None:
            raise ReleaseError(f"the process serving {base} exited with status {process.returncode}")
        try:
            fetch(base + "/healthz")
            return
        except ReleaseError:
            time.sleep(0.5)
    raise ReleaseError(f"nothing answered at {base}")


def local_server_env(site_env: str, snapshot_dir: Path | None, base: dict | None = None, release: str | None = None) -> dict:
    """Environment for the local smoke server: never a database (a developer's own DATABASE_URL must not
    leak in), files mode only when a snapshot directory is given, no SITE_REQUIRE_DATABASE."""
    env = {key: value for key, value in (os.environ if base is None else base).items()
           if key not in ("DATABASE_URL", "SITE_REQUIRE_DATABASE", "SNAPSHOT_DIR")}
    env.update({"PORT": str(LOCAL_PORT), "HOSTNAME": "127.0.0.1", "SITE_ENV": site_env})
    if snapshot_dir is not None:
        env["SNAPSHOT_DIR"] = str(snapshot_dir)
    if release:
        # /healthz reports it at request time (the server container gets it from compose).
        env["RELEASE_ID"] = checked_id(release)
    return env


def with_local_server(app: Path, site_env: str, callback, snapshot_dir: Path | None = None, release: str | None = None):
    """Start the built server with SITE_ENV=site_env, wait for it, return callback(base_url), stop it."""
    server = subprocess.Popen(["node", "server.js"], cwd=app, env=local_server_env(site_env, snapshot_dir, release=release))
    try:
        base = f"http://127.0.0.1:{LOCAL_PORT}"
        wait_until_answering(base, server)
        return callback(base)
    finally:
        server.terminate()
        server.wait()


def run(command, **kwargs):
    print("$", command if isinstance(command, str) else " ".join(map(str, command)), flush=True)
    return subprocess.run(command, check=True, cwd=ROOT, **kwargs)


def git(*args) -> str:
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


DEPLOY_ROOT_CHARS = re.compile(r"[A-Za-z0-9._/-]+")


def valid_deploy_root(path: str) -> bool:
    """An absolute path of at least two components made of safe characters only. It is passed to
    `sudo install -d` on the server, so nothing else is accepted."""
    parts = path.split("/")
    return (bool(DEPLOY_ROOT_CHARS.fullmatch(path)) and path.startswith("/") and "//" not in path
            and not path.endswith("/") and len(parts) >= 3 and "." not in parts and ".." not in parts)


def load_target() -> dict:
    path = ROOT / ".env.deploy"
    if not path.is_file():
        raise ReleaseError("no .env.deploy; copy deploy/deploy.env.example to .env.deploy and fill it in")
    values = dict(line.split("=", 1) for line in path.read_text().splitlines()
                  if "=" in line and not line.lstrip().startswith("#"))
    for key in ("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_ROOT"):
        if not values.get(key, "").strip():
            raise ReleaseError(f".env.deploy lacks {key}")
    target = {key: value.strip() for key, value in values.items()}
    if not valid_deploy_root(target["DEPLOY_ROOT"]):
        raise ReleaseError("DEPLOY_ROOT in .env.deploy must be an absolute path of at least two components "
                           "using only letters, digits, . _ - and /")
    return target


def ssh_base(target: dict, extra: list[str] | None = None) -> list[str]:
    return ["ssh", "-i", os.path.expanduser(target["DEPLOY_SSH_KEY"]), "-o", "IdentitiesOnly=yes",
            "-o", "BatchMode=yes", *(extra or []), f"{target['DEPLOY_USER']}@{target['DEPLOY_HOST']}"]


def free_port() -> int:
    """A port nothing is listening on right now: let the system pick one."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def forward_argv(target: dict, local_port: int, remote_port: int = CANDIDATE["port"]) -> list[str]:
    """ssh command that forwards a local port to a port on the server's loopback, and fails if it cannot.
    Without `remote_port` it reaches the candidate slot."""
    return ssh_base(target, ["-o", "ExitOnForwardFailure=yes", "-N", "-L", f"{local_port}:127.0.0.1:{remote_port}"])


def health_data(body: str) -> dict:
    """`data` of a /healthz body ({} when the body is not that JSON)."""
    try:
        data = json.loads(body).get("data")
    except (ValueError, AttributeError):
        return {}
    return data if isinstance(data, dict) else {}


PUBLISH_DATA_FIRST = "publish data first: pnpm data:release && pnpm data:promote"


def data_release_failures(body: str) -> list[str]:
    """A candidate must serve a release from the database; anything else means the server holds no data release."""
    data = health_data(body)
    if data.get("source") == "database" and data.get("releaseId"):
        return []
    return [f"/healthz reports no database data release ({PUBLISH_DATA_FIRST})"]


def describe_health(body: str | None) -> str:
    """One line for `status`: the code release and the data release a slot reports."""
    if not body or not body.strip():
        return "not running"
    try:
        code = json.loads(body).get("release") or "unknown"
    except (ValueError, AttributeError):
        return "answers, but not with a /healthz body"
    data = health_data(body)
    served = f"data {data['releaseId']} ({data.get('source')})" if data.get("releaseId") else "no data release loaded"
    return f"code {code}, {served}"


# Everything the site needs before it shows sign-in, submit and subscribe (src/lib/app-config.ts).
APP_SETTINGS = ("APP_DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")


def site_env_keys_script(target: dict) -> str:
    """Prints the key names (never the values) of the server's site.env, one per line. No sudo needed."""
    return f"sed -n 's/^\\([A-Z_][A-Z0-9_]*\\)=.*/\\1/p' {site_env_file(target)}"


def sign_in_failures(keys: list[str], read_me) -> list[str]:
    """A candidate whose site.env holds all the user-feature settings must report `enabled: true` on /api/me.
    Without them the features are off by design and nothing is asked. `read_me()` returns the body or raises."""
    if not all(key in keys for key in APP_SETTINGS):
        return []
    try:
        enabled = json.loads(read_me()).get("enabled") is True
    except (ReleaseError, ValueError, AttributeError):
        enabled = False
    return [] if enabled else ["sign-in is configured but not answering"]


def app_database_failures(keys: list[str], health_body: str) -> list[str]:
    """With every sign-in setting on the server, /healthz must say the user database answers (`app.ok`).
    /healthz stays 200 when it does not, so the public site survives; a candidate with it down is not promoted."""
    if not all(key in keys for key in APP_SETTINGS):
        return []
    try:
        app = json.loads(health_body).get("app")
    except (ValueError, AttributeError):
        app = None
    ok = isinstance(app, dict) and app.get("ok") is True
    return [] if ok else ["sign-in is configured but its database is not answering"]


def candidate_failures(target: dict, release: str) -> tuple[list[str], str]:
    """Smoke-test the candidate on the server through an SSH forward, the way a reviewer would see it.
    Returns the failures and the data release the candidate is serving."""
    port = free_port()
    forward = subprocess.Popen(forward_argv(target, port), stdin=subprocess.DEVNULL)
    try:
        base = f"http://127.0.0.1:{port}"
        wait_until_answering(base, forward)
        _, _, body = fetch(base + "/healthz")
        served = health_data(body).get("releaseId") or ""
        try:
            keys = remote(target, site_env_keys_script(target), capture=True).split()
            sign_in = sign_in_failures(keys, lambda: fetch(base + "/api/me")[2]) + app_database_failures(keys, body)
        except subprocess.CalledProcessError:
            sign_in = ["could not read the site settings on the server"]
        return (smoke(base, release) + data_release_failures(body) + indexability(base, indexable=False) + sign_in), served
    finally:
        forward.terminate()
        forward.wait()


def remote(target: dict, script: str, capture: bool = False) -> str:
    result = subprocess.run([*ssh_base(target), "bash", "-euo", "pipefail", "-c", shlex.quote(script)],
                            check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else ""


SAFE_SETTING = re.compile(r"[A-Za-z0-9._~+/=:@%,-]+")
GOOGLE_KEYS = ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")


def read_google_settings(paths=None) -> dict[str, str]:
    """The two Google values from the local .env then .env.local (later wins). Only these two keys are read."""
    import app_db

    paths = app_db.ENV_FILES if paths is None else paths
    values = {}
    for key in GOOGLE_KEYS:
        value = app_db.read_env_value(key, paths)
        if not value:
            raise ReleaseError(f"{key} is missing in the local .env or .env.local")
        values[key] = value
    return values


def site_env_script(target: dict, values: dict[str, str]) -> str:
    """Script (sent on stdin) that sets exactly the two Google keys in the server's site.env: the old lines are
    dropped and the new ones appended, every other line stays, mode 600. The values are inside this text only."""
    if sorted(values) != sorted(GOOGLE_KEYS):
        raise ReleaseError("site:env sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, nothing else")
    for key, value in values.items():
        if not SAFE_SETTING.fullmatch(value):
            raise ReleaseError(f"{key} contains a character that cannot be stored safely in site.env "
                               "(whitespace, quotes, $, #, backslash, backtick or a control character)")
    site_env = site_env_file(target)
    drops = " ".join(f"-e '^{key}='" for key in GOOGLE_KEYS)
    sets = "".join(f"printf '%s=%s\\n' {key} '{values[key]}' >> \"$tmp\"\n" for key in GOOGLE_KEYS)
    return f"""umask 077
f={site_env}
[ -f "$f" ] || {{ echo 'site.env does not exist on the server; run pnpm db:setup first' >&2; exit 1; }}
tmp=$(mktemp "$f.XXXXXX")
trap 'rm -f "$tmp"' EXIT
grep -v {drops} "$f" > "$tmp" || [ $? -eq 1 ]
{sets}chmod 600 "$tmp"
mv "$tmp" "$f"
echo 'set {", ".join(GOOGLE_KEYS)} in site.env'
"""


def env_command() -> None:
    target = load_target()
    remote_stdin(target, site_env_script(target, read_google_settings()))
    print("restart the site for this to take effect: pnpm site:release && pnpm site:promote")


def remote_stdin(target: dict, script: str) -> None:
    """Run a script on the server by sending it on stdin (nothing in it reaches a command line); its output is
    shown as it comes."""
    subprocess.run([*ssh_base(target), "bash", "-euo", "pipefail", "-s"], input=script, text=True, check=True)


def site_env_file(target: dict) -> str:
    """Quoted path of the site's environment file (DATABASE_URL), written by `pnpm db:setup`."""
    return rpath(target, "site.env")


# Every `up --wait` is bounded: a container that crash-loops never turns unhealthy, so without a
# timeout a release could hang for ever.
WAIT = "--wait --wait-timeout 180"


def compose(target: dict, slot: dict, release: str, action: str) -> str:
    return (f"sudo RELEASE_ID={shlex.quote(checked_id(release))} HOST_PORT={slot['port']} SITE_ENV={slot['env']} "
            f"SITE_ENV_FILE={site_env_file(target)} docker compose -p {slot['project']} {action}")


def rpath(target: dict, *parts: str) -> str:
    """A quoted path under the deploy root."""
    return shlex.quote("/".join([target["DEPLOY_ROOT"], *parts]))


def healthy(slot: dict, release: str) -> str:
    """Shell test: the slot answers /healthz and names this release. No early pipe close under pipefail."""
    return f"curl -fsS http://127.0.0.1:{slot['port']}/healthz | grep {shlex.quote(release)} >/dev/null"


def remote_id(target: dict, name: str) -> str:
    """The release id stored in a state file on the server ('' when the file is absent)."""
    value = remote(target, f"cat {rpath(target, name)} 2>/dev/null || true", capture=True)
    return checked_id(value) if value.strip() else ""


def build_release_id() -> str:
    # Untracked files do not change what is built from the commit, so only edits to tracked files mark a release dirty.
    return release_id(datetime.now(timezone.utc), git("rev-parse", "--short", "HEAD"),
                      bool(git("status", "--porcelain", "--untracked-files=no")))


def snapshot_dir_for_smoke() -> Path | None:
    """The local snapshot directory when there is one: the smoke server then runs in files mode."""
    return SNAPSHOT if (SNAPSHOT / "manifest.json").is_file() else None


STATIC_WHITEPAPER = ("en", "zh-CN")
NO_SIGN_IN_AT_BUILD = "the build machine lacks the five sign-in settings; run `pnpm app:setup` and check .env"


def static_sign_in_failures(next_dir: Path) -> list[str]:
    """The whitepaper and the articles are the pages built ahead: they read documents the server does not
    carry. Their layout carries the sign-in menu only when the build machine has the five sign-in settings.
    A release built without them would hide sign-in on those pages. The whitepaper must be there; the
    articles are checked when the build has any."""
    for language in STATIC_WHITEPAPER:
        root = next_dir / "server" / "app" / language
        pages = [root / "whitepaper.html", *sorted(root.glob("articles.html")), *sorted(root.glob("articles/*.html"))]
        for page in pages:
            try:
                if "data-account-menu" in page.read_text(encoding="utf-8"):
                    continue
            except OSError:
                pass
            return [NO_SIGN_IN_AT_BUILD]
    return []


def build() -> str:
    release = build_release_id()
    if release.endswith("-dirty"):
        print("warning: uncommitted changes; this release cannot be reproduced from a commit", file=sys.stderr)
    run(["pnpm", "check"], env={**os.environ, "RELEASE_ID": release})
    missing = static_sign_in_failures(ROOT / ".next")
    if missing:
        raise ReleaseError(missing[0])

    staged = STAGING / release
    shutil.rmtree(STAGING, ignore_errors=True)
    app = staged / "app"
    # `next build` copies the project's .env and .env.production into the standalone
    # directory whatever the tracing config says. They hold local keys and the server
    # reads none of them (the container gets SITE_ENV from compose), so they stay behind.
    # The same goes for the links to `sharp`, whose package is excluded from tracing (next.config.ts).
    shutil.copytree(ROOT / ".next" / "standalone", app, symlinks=True, ignore=shutil.ignore_patterns(".env*", "sharp", "@img"))
    shutil.copytree(ROOT / ".next" / "static", app / ".next" / "static")
    shutil.copytree(ROOT / "public", app / "public")
    shutil.copy(ROOT / "deploy" / "Dockerfile", staged / "Dockerfile")
    shutil.copy(ROOT / "deploy" / "compose.yml", staged / "compose.yml")
    (staged / "release.json").write_text(json.dumps({
        "release": release,
        "commit": git("rev-parse", "HEAD"),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }, indent=2) + "\n")

    foreign = foreign_binaries(staged)
    if foreign:
        raise ReleaseError("release contains native binaries built for this machine:\n  " + "\n  ".join(foreign[:20]))
    found = forbidden_entries(staged)
    if found:
        raise ReleaseError("release contains files that must not be uploaded:\n  " + "\n  ".join(found[:20]))

    snapshot = snapshot_dir_for_smoke()
    if snapshot is None:
        print("no local snapshot: smoke-testing the no-data subset (run `pnpm data:publish:snapshot` for the full list)")
    # Files mode reads the snapshot from outside the release; the release itself contains no data.
    failures = with_local_server(app, "preview", lambda base: smoke(base, release, with_data=snapshot is not None)
                                 + indexability(base, indexable=False), snapshot, release)
    # What the server will run: production answers pages without an X-Robots-Tag.
    failures += with_local_server(app, "production", lambda base: indexability(base, indexable=True), snapshot, release)
    if failures:
        raise ReleaseError("smoke test failed:\n  " + "\n  ".join(failures))
    print(f"built {release} at {staged.relative_to(ROOT)}")
    return release


def candidate_script(target: dict, release: str) -> str:
    """Start the candidate and wait (bounded) for it to be healthy. Its output is shown as it comes."""
    return f"""
cd {rpath(target, "releases", release)}
{compose(target, CANDIDATE, release, f'up -d --build {WAIT}')} && {healthy(CANDIDATE, release)}
"""


def candidate_diagnosis_script() -> str:
    """After a failed start: the candidate's /healthz body on stdout (empty if it does not answer) and the
    last 40 lines of its container log on stderr."""
    return (f"curl -s --max-time 5 http://127.0.0.1:{CANDIDATE['port']}/healthz | head -c 2000 || true\n"
            f"for c in $(sudo docker ps -aq --filter label=com.docker.compose.project={CANDIDATE['project']}); do\n"
            f"  sudo docker logs --tail 40 \"$c\" >&2 || true\n"
            f"done\n")


def candidate_start_failure(body: str) -> str:
    """What to tell the operator. 'Publish data first' only when the site is in database mode and has no release."""
    data = health_data(body)
    if data.get("source") == "database" and "releaseId" in data and data["releaseId"] is None:
        return f"the candidate is running but the database has no active data release: {PUBLISH_DATA_FIRST}"
    return "the candidate did not become healthy; see the output above"


def start_candidate(target: dict, release: str) -> None:
    try:
        remote(target, candidate_script(target, release))
    except subprocess.CalledProcessError:
        diagnosis = subprocess.run([*ssh_base(target), "bash", "-euo", "pipefail", "-c",
                                    shlex.quote(candidate_diagnosis_script())],
                                   text=True, stdout=subprocess.PIPE)
        body = diagnosis.stdout.strip()
        print(f"candidate /healthz: {body or '(no answer)'}", file=sys.stderr)
        raise ReleaseError(f"{candidate_start_failure(body)}\n"
                           f"The candidate container was left running on the server for inspection "
                           f"(127.0.0.1:{CANDIDATE['port']}); the container log is above.") from None


def upload_argv(target: dict, release: str, previous: str = "") -> list[str]:
    """rsync of the staged release into its own directory on the server.

    With a previous release, files that did not change are hard-linked from it on the
    server and changed ones are sent as differences, so a release uploads little.
    Release directories are never edited in place, which is what makes the links safe."""
    key = shlex.quote(os.path.expanduser(target["DEPLOY_SSH_KEY"]))
    link = [f"--link-dest=../{previous}"] if previous and previous != release else []
    return ["rsync", "-az", "--delete", *link, "-e", f"ssh -i {key} -o IdentitiesOnly=yes -o BatchMode=yes",
            f"{STAGING / release}/",
            f"{target['DEPLOY_USER']}@{target['DEPLOY_HOST']}:{target['DEPLOY_ROOT']}/releases/{release}/"]


def release_command() -> None:
    target = load_target()
    release = build()
    user = shlex.quote(target["DEPLOY_USER"])
    # A failed release must not leave an earlier candidate for `promote` to pick up.
    remote(target, f"sudo install -d -o {user} -g {user} {rpath(target)} {rpath(target, 'releases')}"
                   f" && rm -f {rpath(target, 'candidate')}")
    run(upload_argv(target, release, remote_id(target, "live")))
    start_candidate(target, release)
    # Only a candidate that passed is recorded, so `promote` cannot pick up one that did not.
    failures, served = candidate_failures(target, release)
    if failures:
        raise ReleaseError(f"candidate {release} failed its smoke test. It was left running on the server "
                           f"(127.0.0.1:{CANDIDATE['port']}) for inspection and is not recorded as the candidate:\n  "
                           + "\n  ".join(failures))
    remote(target, f"echo {shlex.quote(release)} > {rpath(target, 'candidate')}")
    print(f"\ncandidate {release} is running on the server, serving data release {served}.\n"
          f"preview:  ssh -i {target['DEPLOY_SSH_KEY']} -N -L 8321:127.0.0.1:{CANDIDATE['port']} "
          f"{target['DEPLOY_USER']}@{target['DEPLOY_HOST']}   then open http://localhost:8321\n"
          f"go live:  pnpm site:promote")


def database_precheck(target: dict) -> str:
    """Shell run on the server before production is touched: the database must accept connections as the
    site's role over the container's network address (where the password is enforced) and an active data
    release must exist. Otherwise the script stops, and production is left exactly as it is."""
    env_file = rpath(target, "db", "db.env")
    inside = ('ip=$(hostname -i); ip=${ip%% *}; '
              'pg_isready -q -h "$ip" -U oaw_site -d openaiwill && '
              'PGPASSWORD="$OAW_SITE_PASSWORD" psql -X -h "$ip" -U oaw_site -d openaiwill -tAc '
              '"SELECT release_id FROM kg.active"')
    return (f"active=$(sudo docker exec -i --env-file {env_file} openaiwill-db sh -c '{inside}' </dev/null) "
            f"|| {{ echo 'the database does not accept connections as oaw_site; production was not touched' >&2; exit 1; }}\n"
            f"[ -n \"$active\" ] || {{ echo 'the database has no active data release (pnpm data:promote); "
            f"production was not touched' >&2; exit 1; }}\n")


def switch_script(target: dict, release: str, live: str) -> str:
    """Start `release` as production. If it does not come up healthy, put `live` back.
    Nothing is touched unless the database is reachable and holds an active data release."""
    release_dir = rpath(target, "releases", release)
    if live:
        live_dir = rpath(target, "releases", live)
        done = (f"echo '{live} did not become healthy; it is still the current release' >&2" if live == release
                else f"echo 'production restored to {live}' >&2")
        restore = (f"if [ -d {live_dir} ]; then\n"
                   f"    cd {live_dir} && {compose(target, PRODUCTION, live, f'up -d {WAIT}')} "
                   f"|| {{ echo 'RESTORE FAILED: production is down' >&2; exit 1; }}\n"
                   f"    {done}\n"
                   f"  else echo 'RESTORE FAILED: production is down; {live} is gone' >&2; exit 1; fi")
        remember = f"echo {shlex.quote(live)} > {rpath(target, 'previous')}" if live != release else ":"
    else:
        # Nothing to go back to: the unhealthy container would keep the production port with `restart: unless-stopped`.
        restore = (f"{compose(target, PRODUCTION, release, 'down')} || echo 'could not stop the production slot' >&2\n"
                   f"  echo 'no earlier release to restore; production slot stopped' >&2")
        remember = ":"
    return f"""
test -d {release_dir}
{database_precheck(target)}cd {release_dir}
if ! ( {compose(target, PRODUCTION, release, f'up -d --build {WAIT}')} && {healthy(PRODUCTION, release)} ); then
  echo 'release {release} did not become healthy' >&2
  {restore}
  exit 1
fi
{remember}
echo {shlex.quote(release)} > {rpath(target, 'current')}
"""


def switch(target: dict, release: str) -> None:
    release = checked_id(release)
    remote(target, switch_script(target, release, remote_id(target, "current")))


def public_check_message(release: str, failures: list[str]) -> str:
    """Production is already switched and healthy on the server; say what that leaves the operator to do."""
    head = f"production IS switched to {release} and healthy on the server, but the public check failed:\n  "
    listed = "\n  ".join(failures)
    if all(is_reachability(failure) for failure in failures):
        return (f"{head}{listed}\nThe public address does not answer: fix the Tunnel/DNS, then run "
                "`pnpm site:indexnow`. Do not roll back for this.")
    return (f"{head}{listed}\nFix what is listed (`pnpm site:rollback` returns to the previous release if the "
            "page itself is wrong), then run `pnpm site:indexnow`.")


def www_redirect_failures(fetcher=fetch) -> list[str]:
    """www.<site> must send readers to the apex (the site does it itself; a Cloudflare rule may too, with a 301).
    A www address that does not answer is not a failure here: it may simply not be in DNS."""
    www = SITE_URL.replace("https://", "https://www.", 1)
    try:
        code, headers, _ = fetcher(www + "/")
    except ReleaseError:
        return []
    where = headers.get("Location")
    if code in (301, 308) and where in (SITE_URL, SITE_URL + "/"):
        return []
    return [f"{www}/: status {code} Location {where!r}, expected 308 to {SITE_URL}"]


def promote_command() -> None:
    target = load_target()
    release = remote_id(target, "candidate")
    if not release:
        raise ReleaseError("there is no candidate; run `pnpm site:release` first")
    remote(target, healthy(CANDIDATE, release))
    switch(target, release)
    remote(target, f"cd {rpath(target, 'releases', release)} && {compose(target, CANDIDATE, release, 'down')} "
                   f"&& rm -f {rpath(target, 'candidate')}")
    listing = remote(target, f"ls {rpath(target, 'releases')}", capture=True).split()
    protected = set(valid_ids(remote(target, f"cat {rpath(target, 'current')} {rpath(target, 'previous')} "
                                              "2>/dev/null || true", capture=True).split()))
    for old in to_prune(listing, KEEP, protected):
        remote(target, f"rm -rf {rpath(target, 'releases', old)}; "
                       f"sudo docker image rm -f {shlex.quote('openaiwill-web:' + old)} >/dev/null 2>&1 || true")
    print(f"production is now {release}")
    failures = smoke(SITE_URL, release)
    if not any("is not reachable" in failure for failure in failures):
        failures += indexability(SITE_URL, indexable=True)
        failures += www_redirect_failures()
    if failures:
        raise ReleaseError(public_check_message(release, failures))
    notify_indexnow()


def rollback_command() -> None:
    target = load_target()
    release = remote_id(target, "previous")
    if not release:
        raise ReleaseError("there is no previous release to roll back to")
    switch(target, release)
    print(f"production is back on {release}")


def health_probe_script() -> str:
    """Each slot's /healthz body on one marked line (empty when the slot does not answer)."""
    lines = [f'echo "{name}:$(curl -s --max-time 5 http://127.0.0.1:{slot["port"]}/healthz | head -c 2000 | tr -d \'\\n\' || true)"'
             for name, slot in (("PRODUCTION", PRODUCTION), ("CANDIDATE", CANDIDATE))]
    return "\n".join(lines)


def parse_probe(output: str) -> dict[str, str]:
    """{'PRODUCTION': body, 'CANDIDATE': body} from health_probe_script's output."""
    found = {}
    for line in output.splitlines():
        name, _, body = line.partition(":")
        if name in ("PRODUCTION", "CANDIDATE"):
            found[name] = body
    return found


def status_command() -> None:
    target = load_target()
    print(remote(target, f"""
echo "current:   $(cat {rpath(target, 'current')} 2>/dev/null || echo none)"
echo "previous:  $(cat {rpath(target, 'previous')} 2>/dev/null || echo none)"
echo "candidate: $(cat {rpath(target, 'candidate')} 2>/dev/null || echo none)"
echo "releases:  $(ls {rpath(target, 'releases')} 2>/dev/null | tr '\\n' ' ')"
sudo docker ps --filter name=openaiwill --format '{{{{.Names}}}}  {{{{.Image}}}}  {{{{.Status}}}}  {{{{.Ports}}}}'
""", capture=True))
    probes = parse_probe(remote(target, health_probe_script(), capture=True))
    print(f"production slot (:{PRODUCTION['port']}): {describe_health(probes.get('PRODUCTION'))}")
    print(f"candidate slot (:{CANDIDATE['port']}):  {describe_health(probes.get('CANDIDATE'))}")


def sitemap_entries(xml: str) -> dict[str, str]:
    """Each address in a sitemap with its lastmod ('' when the entry has none)."""
    entries = {}
    for block in re.findall(r"<url>(.*?)</url>", xml, re.S):
        loc = re.search(r"<loc>([^<]+)</loc>", block)
        if loc:
            lastmod = re.search(r"<lastmod>([^<]+)</lastmod>", block)
            entries[html.unescape(loc.group(1).strip())] = lastmod.group(1).strip() if lastmod else ""
    return entries


def changed_addresses(previous: dict[str, str] | None, current: dict[str, str]) -> list[str]:
    """The addresses IndexNow should hear about: new ones, ones whose lastmod moved, and ones that are gone
    (an engine that fetches a removed address finds the 404). With no baseline, every current address."""
    if previous is None:
        return sorted(current)
    moved = [url for url, lastmod in current.items() if previous.get(url) != lastmod]
    gone = [url for url in previous if url not in current]
    return sorted(moved + gone)


def load_indexnow_state(path: Path = INDEXNOW_STATE) -> dict[str, str] | None:
    try:
        entries = json.loads(path.read_text())["entries"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return entries if isinstance(entries, dict) else None


def save_indexnow_state(entries: dict[str, str], path: Path = INDEXNOW_STATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sent_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    path.write_text(json.dumps({"sent_at": sent_at, "entries": entries}, indent=1, sort_keys=True) + "\n")


def submit_indexnow(key: str, urls: list[str]) -> bool:
    """Send the addresses in batches the protocol accepts. True when every batch was accepted."""
    for start in range(0, len(urls), INDEXNOW_BATCH):
        batch = urls[start:start + INDEXNOW_BATCH]
        body = json.dumps({"host": SITE_URL.removeprefix("https://"), "key": key,
                           "keyLocation": f"{SITE_URL}/{key}.txt", "urlList": batch}).encode()
        request = urllib.request.Request("https://api.indexnow.org/indexnow", data=body,
                                         headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                print(f"IndexNow: {response.status} for {len(batch)} addresses")
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            print(f"IndexNow not notified ({error}); the release itself is unaffected", file=sys.stderr)
            return False
    return True


def notify_indexnow(only_changed: bool = False, state: Path = INDEXNOW_STATE) -> None:
    """Tell IndexNow-fed engines (Bing, and through it ChatGPT search) about the live sitemap's addresses:
    all of them, or with `only_changed` those that differ from the sitemap IndexNow last accepted. The
    accepted sitemap becomes the next baseline. Never fails the release that called it."""
    key = indexnow_key()
    if not key:
        print("no IndexNow key in public/; skipped")
        return
    try:
        code, _, sitemap = fetch(SITE_URL + "/sitemap.xml")
    except ReleaseError as error:
        print(f"IndexNow not notified ({error}); the release itself is unaffected", file=sys.stderr)
        return
    current = sitemap_entries(sitemap)
    if code != 200 or not current:
        print(f"IndexNow not notified (the sitemap answered {code} with {len(current)} addresses); "
              "the release itself is unaffected", file=sys.stderr)
        return
    previous = load_indexnow_state(state) if only_changed else None
    urls = changed_addresses(previous, current)
    if only_changed and previous is None:
        print("IndexNow: no earlier sitemap on record; sending every address")
    if not urls:
        print(f"IndexNow: none of the {len(current)} addresses changed; nothing sent")
        return
    if submit_indexnow(key, urls):
        save_indexnow_state(current, state)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["build", "release", "promote", "rollback", "status", "indexnow", "env"])
    command = parser.parse_args().command
    try:
        {"build": build, "release": release_command, "promote": promote_command,
         "rollback": rollback_command, "status": status_command, "indexnow": notify_indexnow,
         "env": env_command}[command]()
    except ReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"error: command failed with status {error.returncode}", file=sys.stderr)
        return error.returncode or 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
