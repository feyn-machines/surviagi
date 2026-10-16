#!/usr/bin/env python3
"""One command that brings the site's data up to date: collect, process, publish.

    pnpm data:daily              collect and process the next window, then `data:release` (not live)
    pnpm data:daily --promote    ... and make it live when nothing needs a person's look
    pnpm data:daily --plan       print the window and the steps; run nothing

The window starts where the last completed one ended (`data/daily/state.json`; before the first run,
the end of the newest official collection run) and ends at the last full hour. Each window has its own
directory `data/daily/<tag>/` with one log per step and a `done` list: a run that stops part-way is
picked up at the step that stopped, so posts are not collected or sent to a model twice. The cursor
moves only once the snapshot is written.

Before the first judge call, TypeSafe must be reachable from here (a region block answers 451); if it
is not, the run stops and keeps its place. A step that reports failed or fallback batches, or a crawl
that finished needing attention, keeps the release from going live: the release is still imported and
verified, and the report says why it was held.

Exit status: 0 published (or nothing to do), 2 done but held or needing a look, 1 stopped.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
DAILY = ROOT / "data" / "daily"
STATE = DAILY / "state.json"
OFFICIAL_RUNS = ROOT / "data" / "collection" / "official-x"
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
MIN_WINDOW = timedelta(hours=6)
RELEASE_ATTEMPTS = 3


class Stop(Exception):
    """The run cannot go on; it keeps its place for the next one."""


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime

    @property
    def tag(self) -> str:
        # Hours and minutes too: two windows on the same day must not share files or a record.
        return f"{self.start:%Y-%m-%dT%H%M}_{self.end:%Y-%m-%dT%H%M}"

    def iso(self, moment: datetime) -> str:
        return moment.astimezone(timezone.utc).isoformat()


@dataclass
class Step:
    name: str
    argv: list[str]
    check: Callable[["Outcome"], list[str]] = lambda _outcome: []
    # What a person may want to read, without holding the release.
    notes: Callable[["Outcome"], list[str]] = lambda _outcome: []
    # Exit statuses that still count as finished (the crawler's 2 = finished but needs attention).
    finished: tuple[int, ...] = (0,)
    before: Callable[[], None] | None = None


@dataclass
class Outcome:
    returncode: int
    stdout: str
    seconds: float
    result: dict = field(default_factory=dict)


def parse_time(value: str) -> datetime:
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        raise ValueError(f"{value!r} has no time zone")
    return moment.astimezone(timezone.utc)


def last_full_hour(now: datetime) -> datetime:
    return now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def newest_collection_end(runs: Path = OFFICIAL_RUNS) -> datetime | None:
    """Where the newest official collection run's window ended (runs made by hand count too)."""
    ends = []
    for path in runs.glob("*.json"):
        try:
            window = json.loads(path.read_text(encoding="utf-8")).get("publication_window") or {}
            ends.append(parse_time(window["end"]))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return max(ends, default=None)


def read_state(path: Path = STATE) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def write_state(state: dict, path: Path = STATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def next_window(state: dict, now: datetime, collection_end: datetime | None) -> Window | None:
    """The window to work on: the pending one if a run stopped part-way, else the next one.
    None when less than MIN_WINDOW has passed since the last one ended."""
    pending = state.get("pending")
    if pending:
        return Window(parse_time(pending["start"]), parse_time(pending["end"]))
    if state.get("window_end"):
        start = parse_time(state["window_end"])
    elif collection_end is not None:
        start = collection_end
    else:
        raise Stop("no earlier window: give --start for the first run")
    end = last_full_hour(now)
    if end - start < MIN_WINDOW:
        return None
    return Window(start, end)


def json_result(stdout: str) -> dict:
    """The JSON object a pipeline command printed last ({} when it printed none)."""
    text = stdout.strip()
    for start in [i for i, ch in enumerate(text) if ch == "{" and (i == 0 or text[i - 1] == "\n")]:
        try:
            value = json.loads(text[start:])
        except ValueError:
            continue
        return value if isinstance(value, dict) else {}
    return {}


# What the pipeline commands call work they could not do, or did with the fallback judge.
PROBLEM_KEYS = ("failed", "failed_batches", "batches_failed", "fallback_batches", "events_incomplete",
                "activities_incomplete")


def problems_in(value, path: str = "") -> list[str]:
    """Every PROBLEM_KEYS entry that is a positive count or a non-empty list, anywhere in `value`."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            where = f"{path}.{key}" if path else key
            if key in PROBLEM_KEYS and ((isinstance(item, (int, float)) and not isinstance(item, bool) and item > 0)
                                        or (isinstance(item, list) and item)):
                found.append(f"{where} = {len(item) if isinstance(item, list) else item}")
            else:
                found += problems_in(item, where)
    return found


def batch_problems(outcome: Outcome) -> list[str]:
    return problems_in(outcome.result)


def extraction_problems(output: Path) -> Callable[[Outcome], list[str]]:
    """Extraction prints only a warning when some batches fail; the count is in its output file."""
    def check(_outcome: Outcome) -> list[str]:
        try:
            params = json.loads(output.read_text(encoding="utf-8")).get("params") or {}
        except (OSError, ValueError):
            return [f"{output.name} cannot be read"]
        return problems_in({"failed_batches": params.get("failed_batches") or []})
    return check


# Above this share of jobs left incomplete, a crawl's gaps hold the release back.
INCOMPLETE_JOBS_HELD = 0.05
INGESTED = "Ingested into the collection store:"


def crawl_review(run_file: Path, outcome: Outcome) -> tuple[list[str], list[str]]:
    """(problems that hold the release, notes that do not) for a crawl that ran.

    The crawler exits 2 for anything short of every job ending cleanly. One record it could not parse
    (`parse_error:*`) refuses that record only; the release goes out with a note. A changed X schema, a
    failed ingest, or more than INCOMPLETE_JOBS_HELD of the jobs left incomplete hold it."""
    if outcome.returncode == 0:
        return [], []
    if INGESTED not in outcome.stdout:
        return ["the crawl's run was not ingested; ingest it with `pnpm data:ingest:x <run>.json`"], []
    try:
        run = json.loads(run_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [f"{run_file.name} cannot be read"], []
    if run.get("schema_change"):
        return [f"X answered in a shape the crawler does not know: {run['schema_change']}"], []
    jobs = run.get("jobs") or []
    incomplete = [j for j in jobs if j.get("status") != "search_ended"]
    listed = [f"@{j.get('handle')}: {j.get('stop_reason')}" for j in incomplete]
    if jobs and len(incomplete) / len(jobs) > INCOMPLETE_JOBS_HELD:
        return [f"{len(incomplete)} of {len(jobs)} jobs incomplete: " + ", ".join(listed[:10])], []
    if incomplete and all(str(j.get("stop_reason", "")).startswith("parse_error") for j in incomplete):
        return [], [f"{len(incomplete)} of {len(jobs)} jobs refused a record: " + ", ".join(listed)]
    if incomplete:
        return [f"{len(incomplete)} of {len(jobs)} jobs incomplete: " + ", ".join(listed)], []
    return [], [f"the crawl exited {outcome.returncode} with every job complete"]


def typesafe_preflight(url: str = TYPESAFE_URL, opener=urllib.request.urlopen) -> None:
    """TypeSafe must answer from this machine; any HTTP answer but 451 (region block) means it does."""
    request = urllib.request.Request(url, data=b"{}", method="POST", headers={"Content-Type": "application/json"})
    try:
        opener(request, timeout=30).close()
    except urllib.error.HTTPError as answer:
        answer.close()
        if answer.code == 451:
            raise Stop("TypeSafe answers 451 (region block) from this machine: route typesafe.ai through a "
                       "US exit in the proxy, then run again")
    except (urllib.error.URLError, OSError) as error:
        raise Stop(f"TypeSafe is not reachable from this machine: {error}")


def pnpm(*args: str) -> list[str]:
    return ["pnpm", "-s", *args]


def steps(window: Window, root: Path = ROOT) -> list[Step]:
    tag = window.tag
    start, end = window.iso(window.start), window.iso(window.end)
    official, panel = f"official-{tag}", f"panel-{tag}"
    extraction = f"data/extraction/v230-{tag}.json"
    official_run, panel_run = f"data/collection/official-x/{official}.json", f"data/collection/panel/{panel}.json"

    def crawl(run_file: str) -> dict:
        return {"check": lambda outcome: crawl_review(root / run_file, outcome)[0],
                "notes": lambda outcome: crawl_review(root / run_file, outcome)[1], "finished": (0, 2)}

    # Extraction files are immutable: one written by a run that stopped before ingesting it is ingested.
    extract = (pnpm("data:ingest:events", extraction) if (root / extraction).exists() else
               pnpm("data:extract:events", "--collection-run", official, "--collection-run", panel,
                    "--window-start", start, "--window-end", end, "--output", extraction))
    return [
        Step("crawl-official", pnpm("crawl", "timeline", "--targets", "official", "--start", start, "--end", end,
                                    "--output", official_run), **crawl(official_run)),
        Step("crawl-panel", pnpm("crawl", "timeline", "--targets", "panel", "--start", start, "--end", end,
                                 "--output", panel_run), **crawl(panel_run)),
        Step("extract-events", extract, check=extraction_problems(root / extraction)),
        Step("verify", pnpm("data:verify"), check=batch_problems, before=typesafe_preflight),
        Step("identify-models", pnpm("data:identify:models"), check=batch_problems),
        Step("route-events", pnpm("data:route:events"), check=batch_problems, before=typesafe_preflight),
        Step("measure-markets", pnpm("data:measure:markets"), check=batch_problems),
        Step("gate-state", pnpm("data:gate:state"), check=batch_problems),
        Step("mine-topics", pnpm("data:mine:topics", "--window-start", start, "--window-end", end,
                                 "--output", f"data/topics/topics-{tag}.json"), check=batch_problems),
        Step("topic-evidence", pnpm("data:topics:evidence", "--since", f"{window.start:%Y-%m-%d}T00:00:00+00:00"),
             check=batch_problems, before=typesafe_preflight),
        Step("post-events", pnpm("data:post-events")),
        Step("activity-state", pnpm("data:activity:state")),
        Step("publish-snapshot", pnpm("data:publish:snapshot")),
        # The local database keeps the same releases as the server, so the two can be compared.
        Step("local-release", pnpm("data:local:release")),
        Step("local-promote", pnpm("data:local:promote")),
        # A Chinese brief of what this window changed: data/reports/changes-<from>_<to>.md.
        Step("changes", pnpm("data:changes")),
    ]


def run_step(step: Step, log: Path) -> Outcome:
    """Run one step with its output kept in `log`; stdout is also returned for its result."""
    started = time.monotonic()
    with log.open("w", encoding="utf-8") as stderr:
        process = subprocess.run(step.argv, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=stderr)
    with log.open("a", encoding="utf-8") as out:
        out.write("\n--- stdout\n" + process.stdout)
    outcome = Outcome(process.returncode, process.stdout, time.monotonic() - started)
    outcome.result = json_result(process.stdout)
    return outcome


class Daily:
    """One invocation. `runner` and `now` are injectable for tests."""

    def __init__(self, *, root: Path = ROOT, state_path: Path = STATE, daily_dir: Path = DAILY, runner=run_step,
                 now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                 collection_end: Callable[[], datetime | None] = newest_collection_end,
                 out=lambda line: print(line, flush=True), sleep=time.sleep):
        self.root, self.state_path, self.daily_dir, self.runner = root, state_path, daily_dir, runner
        self.now, self.collection_end, self.out, self.sleep = now, collection_end, out, sleep

    def window(self, start: str | None) -> tuple[dict, Window | None]:
        state = read_state(self.state_path)
        if start and not state.get("pending"):
            state = {**state, "window_end": parse_time(start).isoformat()}
        return state, next_window(state, self.now(), self.collection_end())

    def process(self, state: dict, window: Window) -> list[str]:
        """Run the window's steps that are not done yet. Returns what needs a person's look."""
        folder = self.daily_dir / window.tag
        folder.mkdir(parents=True, exist_ok=True)
        state["pending"] = {"start": window.start.isoformat(), "end": window.end.isoformat()}
        write_state(state, self.state_path)
        record_path = folder / "record.json"
        record = json.loads(record_path.read_text(encoding="utf-8")) if record_path.exists() else {"steps": {}}
        for number, step in enumerate(steps(window, self.root), 1):
            if step.name in record["steps"] and record["steps"][step.name]["finished"]:
                continue
            if step.before:
                step.before()
            self.out(f"[{number:02}] {step.name} ...")
            outcome = self.runner(step, folder / f"{number:02}-{step.name}.log")
            finished = outcome.returncode in step.finished
            problems = step.check(outcome) if finished else []
            notes = step.notes(outcome) if finished else []
            record["steps"][step.name] = {"finished": finished, "exit": outcome.returncode,
                                          "seconds": round(outcome.seconds, 1), "problems": problems,
                                          "notes": notes,
                                          "result": outcome.result,
                                          "said": (outcome.stdout.strip().splitlines() or [""])[-1]}
            record_path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            self.out(f"     exit {outcome.returncode} in {outcome.seconds:.0f}s"
                     + "".join(f"\n     ! {p}" for p in problems) + "".join(f"\n     - {n}" for n in notes))
            if not finished:
                raise Stop(f"{step.name} failed (exit {outcome.returncode}); log: {folder / f'{number:02}-{step.name}.log'}")
        state.pop("pending", None)
        state["window_end"] = window.end.isoformat()
        write_state(state, self.state_path)
        self.out(f"window done; brief: {record['steps']['changes']['said']}")
        return [p for name, s in record["steps"].items() for p in (f"{name}: {x}" for x in s["problems"])]

    def publish(self, promote: bool, held: list[str]) -> int:
        """Import the snapshot as a verified release on the server; make it live only when nothing is held."""
        release = Step("data:release", pnpm("data:release"))
        for attempt in range(1, RELEASE_ATTEMPTS + 1):
            # One log per attempt: a retry must not overwrite why the one before failed.
            outcome = self.runner(release, self.daily_dir / f"release-{attempt}.log")
            if outcome.returncode == 0:
                break
            # The release is one transaction; a dropped SSH forward leaves nothing behind.
            self.out(f"data:release failed (exit {outcome.returncode}), attempt {attempt} of {RELEASE_ATTEMPTS}")
            if attempt == RELEASE_ATTEMPTS:
                raise Stop(f"data:release kept failing; see {self.daily_dir}/release-*.log")
            self.sleep(60)
        self.out(outcome.stdout.strip())
        if held:
            self.out("not made live; these need a person's look first:\n  " + "\n  ".join(held))
            return 2
        if not promote:
            self.out("verified, not live: `pnpm data:promote` makes it live")
            return 0
        outcome = self.runner(Step("data:promote", pnpm("data:promote")), self.daily_dir / "promote.log")
        self.out(outcome.stdout.strip())
        if outcome.returncode != 0:
            raise Stop("data:promote failed; see data/daily/promote.log")
        return 0

    def main(self, argv: list[str] | None = None) -> int:
        parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
        parser.add_argument("--promote", action="store_true", help="make the release live when nothing is held")
        parser.add_argument("--plan", action="store_true", help="print the window and the steps; run nothing")
        parser.add_argument("--start", help="where the window starts (first run only; ISO time with zone)")
        parser.add_argument("--no-publish", action="store_true", help="stop after the snapshot")
        args = parser.parse_args(argv)
        try:
            state, window = self.window(args.start)
            if window is None:
                self.out(f"nothing to do: the last window ended at {state.get('window_end')}, "
                         f"less than {MIN_WINDOW} ago")
                return 0
            self.out(f"window {window.iso(window.start)} .. {window.iso(window.end)}"
                     + (" (resuming)" if state.get("pending") else ""))
            if args.plan:
                for number, step in enumerate(steps(window, self.root), 1):
                    self.out(f"[{number:02}] {' '.join(step.argv)}")
                return 0
            self.daily_dir.mkdir(parents=True, exist_ok=True)
            with (self.daily_dir / ".lock").open("w") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Stop("another data:daily run is in progress")
                held = self.process(state, window)
                if args.no_publish:
                    self.out("snapshot written; not published (--no-publish)")
                    return 2 if held else 0
                return self.publish(args.promote, held)
        except Stop as stop:
            self.out(f"stopped: {stop}")
            return 1


if __name__ == "__main__":
    if not shutil.which("pnpm") and (Path.home() / ".local" / "bin" / "pnpm").exists():
        os.environ["PATH"] = f"{Path.home() / '.local' / 'bin'}:{os.environ.get('PATH', '')}"
    sys.exit(Daily().main())
