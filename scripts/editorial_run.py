"""Private, local-only run ledger for the editorial workflow.

The ledger records identifiers, hashes, stage outcomes and integer cost units. It
never stores source captures, draft text, credentials or model prompts.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LEDGER = ROOT / "data" / "editorial" / "runs.sqlite3"
STAGES = ("topic_selection", "evidence_brief", "draft_en", "draft_zh",
          "preflight", "prepublish", "agent_verify", "review_queue")
MODEL_STAGES = frozenset(("topic_selection", "evidence_brief", "draft_en", "draft_zh"))
SELECTION_DECISIONS = ("new_article", "revise_existing", "evidence_only", "hold_for_evidence", "no_qualifying_topic")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_KEY = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,119}$")
SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$")
SAFE_CODE = re.compile(r"^[a-z0-9_]{1,64}$")


class LedgerError(Exception):
    """A workflow state or input error that the operator can act on."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _require_key(value: str, name: str) -> str:
    if not isinstance(value, str) or not SAFE_KEY.fullmatch(value):
        raise LedgerError(f"{name} must be a short lowercase identifier")
    return value


def _require_hash(value: str, name: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise LedgerError(f"{name} must be a 64-character lowercase SHA-256")
    return value


def _require_model(value: str) -> str:
    if not isinstance(value, str) or not SAFE_MODEL.fullmatch(value):
        raise LedgerError("model id must be a short, non-sensitive identifier")
    return value


class EditorialRunLedger:
    """Durable state machine; callers provide no draft or evidence text."""

    def __init__(self, path: Path = DEFAULT_LEDGER):
        self.path = Path(path)
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if parent.is_symlink() or parent.parent.is_symlink() or not parent.is_dir():
            raise LedgerError("editorial ledger directory must be a real directory")
        os.chmod(parent, 0o700)
        if self.path.is_symlink():
            raise LedgerError("editorial ledger must not be a symbolic link")
        if not self.path.exists():
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
            except FileExistsError:
                # Another local process may have initialized the file between
                # exists() and open(); verify the winner below before using it.
                pass
        if not self.path.is_file() or stat.S_IMODE(self.path.stat().st_mode) != 0o600:
            raise LedgerError("editorial ledger must be a private regular file with mode 0600")
        self._initialize()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    def _initialize(self) -> None:
        with closing(self._connect()) as conn:
            schema_version = conn.execute("PRAGMA user_version").fetchone()[0]
            if schema_version not in (0, 1):
                raise LedgerError("unsupported editorial ledger schema version")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    run_key TEXT NOT NULL UNIQUE,
                    input_ref TEXT NOT NULL,
                    input_sha256 TEXT NOT NULL,
                    topic_key TEXT NOT NULL,
                    skill_version TEXT NOT NULL,
                    policy_version TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN (
                        'ready', 'running', 'paused', 'held', 'budget_held', 'failed', 'complete', 'no_topic')),
                    budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
                    budget_spent INTEGER NOT NULL DEFAULT 0 CHECK (budget_spent >= 0),
                    budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved >= 0),
                    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
                    article_id TEXT,
                    article_version INTEGER CHECK (article_version IS NULL OR article_version > 0),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS stages (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    name TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'failed', 'held', 'succeeded')),
                    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                    reserved_cost INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost >= 0),
                    actual_cost INTEGER NOT NULL DEFAULT 0 CHECK (actual_cost >= 0),
                    model_id TEXT,
                    input_sha256 TEXT,
                    output_sha256 TEXT,
                    error_code TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, name),
                    UNIQUE (run_id, ordinal)
                );
                CREATE TABLE IF NOT EXISTS events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    stage TEXT,
                    kind TEXT NOT NULL,
                    from_state TEXT,
                    to_state TEXT NOT NULL,
                    attempt INTEGER,
                    cost INTEGER NOT NULL DEFAULT 0,
                    reserved_cost INTEGER NOT NULL DEFAULT 0,
                    model_id TEXT,
                    input_sha256 TEXT,
                    output_sha256 TEXT,
                    error_code TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS editorial_run_events_by_run
                    ON events (run_id, event_id);
                CREATE TABLE IF NOT EXISTS selections (
                    run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
                    decision TEXT NOT NULL CHECK (decision IN (
                        'new_article', 'revise_existing', 'evidence_only', 'hold_for_evidence', 'no_qualifying_topic')),
                    topic_key TEXT NOT NULL,
                    article_id TEXT,
                    created_at TEXT NOT NULL
                );
            """)
            conn.execute("PRAGMA user_version = 1")
        os.chmod(self.path, 0o600)

    @staticmethod
    def _run_id(run_key: str) -> str:
        return hashlib.sha256(run_key.encode("utf-8")).hexdigest()[:24]

    @staticmethod
    def _run_view(row) -> dict:
        return dict(row)

    def create_run(self, *, input_ref: str, input_sha256: str, topic_key: str,
                   skill_version: str, policy_version: str, model_version: str, budget_limit: int,
                   max_attempts: int = 3, no_topic: bool = False) -> tuple[dict, bool]:
        input_ref = _require_key(input_ref, "input reference")
        input_sha256 = _require_hash(input_sha256, "input hash")
        topic_key = "no-qualifying-topic" if no_topic else _require_key(topic_key, "topic key")
        skill_version = _require_key(skill_version, "skill version")
        policy_version = _require_key(policy_version, "policy version")
        model_version = _require_key(model_version, "model version")
        if not isinstance(budget_limit, int) or not 0 <= budget_limit <= 9223372036854775807:
            raise LedgerError("budget limit must be a non-negative 64-bit integer")
        if not isinstance(max_attempts, int) or not 1 <= max_attempts <= 10:
            raise LedgerError("max attempts must be from 1 to 10")
        canonical = json.dumps([input_ref, input_sha256, topic_key, skill_version,
                                policy_version, model_version], separators=(",", ":"))
        run_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        run_id = self._run_id(run_key)
        now = _now()
        state = "no_topic" if no_topic else "ready"
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            old = conn.execute("SELECT * FROM runs WHERE run_key = ?", (run_key,)).fetchone()
            if old:
                if old["budget_limit"] != budget_limit or old["max_attempts"] != max_attempts:
                    raise LedgerError("an idempotent run already exists with a different budget or retry limit")
                conn.commit()
                return self._run_view(old), False
            conn.execute(
                "INSERT INTO runs (run_id,run_key,input_ref,input_sha256,topic_key,skill_version,policy_version,model_version,state,budget_limit,max_attempts,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, run_key, input_ref, input_sha256, topic_key, skill_version, policy_version, model_version,
                 state, budget_limit, max_attempts, now, now),
            )
            for ordinal, stage in enumerate(STAGES):
                conn.execute(
                    "INSERT INTO stages (run_id,name,ordinal,state,updated_at) VALUES (?,?,?,'pending',?)",
                    (run_id, stage, ordinal, now),
                )
            conn.execute(
                "INSERT INTO events (run_id,kind,to_state,created_at) VALUES (?,?,?,?)",
                (run_id, "no_topic" if no_topic else "created", state, now),
            )
            row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            conn.commit()
            return self._run_view(row), True

    def start_stage(self, run_id: str, stage: str, *, input_sha256: str,
                    reserve_cost: int = 0, model_id: str | None = None) -> dict:
        if stage not in STAGES:
            raise LedgerError("unknown editorial stage")
        input_sha256 = _require_hash(input_sha256, "stage input hash")
        if not isinstance(reserve_cost, int) or reserve_cost < 0:
            raise LedgerError("reserved cost must be a non-negative integer")
        if model_id is not None:
            model_id = _require_model(model_id)
        now = _now()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            run = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            if not run:
                raise LedgerError("unknown run")
            if run["state"] not in ("ready", "running"):
                raise LedgerError(f"run cannot start a stage while {run['state']}")
            current = conn.execute("SELECT * FROM stages WHERE run_id = ? AND name = ?", (run_id, stage)).fetchone()
            if current["state"] in ("running", "succeeded", "held"):
                raise LedgerError("stage is already running, complete, or held")
            active = conn.execute("SELECT name FROM stages WHERE run_id=? AND state='running' LIMIT 1", (run_id,)).fetchone()
            if active:
                raise LedgerError(f"finish active stage first: {active['name']}")
            prior = conn.execute(
                "SELECT name FROM stages WHERE run_id = ? AND ordinal < ? AND state <> 'succeeded' LIMIT 1",
                (run_id, current["ordinal"]),
            ).fetchone()
            if prior:
                raise LedgerError(f"finish earlier stage first: {prior['name']}")
            if stage in MODEL_STAGES and model_id is None:
                raise LedgerError("model-assisted stages require the model identifier")
            if stage in MODEL_STAGES and reserve_cost == 0:
                raise LedgerError("model-assisted stages require a positive cost reservation")
            if current["attempts"] >= run["max_attempts"]:
                conn.execute("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?", (now, run_id))
                conn.execute("INSERT INTO events (run_id,stage,kind,from_state,to_state,error_code,created_at) VALUES (?,?,?,?,?,?,?)",
                             (run_id, stage, "retry_limit", run["state"], "failed", "retry_limit", now))
                conn.commit()
                raise LedgerError("stage retry limit reached")
            if run["budget_spent"] + run["budget_reserved"] + reserve_cost > run["budget_limit"]:
                conn.execute("UPDATE runs SET state = 'budget_held', updated_at = ? WHERE run_id = ?", (now, run_id))
                conn.execute("INSERT INTO events (run_id,stage,kind,from_state,to_state,error_code,created_at) VALUES (?,?,?,?,?,?,?)",
                             (run_id, stage, "budget_hold", run["state"], "budget_held", "budget_exhausted", now))
                conn.commit()
                raise LedgerError("budget limit would be exceeded")
            attempt = current["attempts"] + 1
            conn.execute(
                "UPDATE stages SET state='running',attempts=?,reserved_cost=?,input_sha256=?,model_id=?,error_code=NULL,updated_at=? WHERE run_id=? AND name=?",
                (attempt, reserve_cost, input_sha256, model_id, now, run_id, stage),
            )
            conn.execute("UPDATE runs SET state='running',budget_reserved=budget_reserved+?,updated_at=? WHERE run_id=?",
                         (reserve_cost, now, run_id))
            conn.execute("INSERT INTO events (run_id,stage,kind,from_state,to_state,attempt,reserved_cost,model_id,input_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (run_id, stage, "stage_started", current["state"], "running", attempt,
                          reserve_cost, model_id, input_sha256, now))
            conn.commit()
            return {"run_id": run_id, "stage": stage, "attempt": attempt, "reserve_cost": reserve_cost}

    def finish_stage(self, run_id: str, stage: str, *, outcome: str,
                     actual_cost: int = 0, output_sha256: str | None = None,
                     error_code: str | None = None, article_id: str | None = None,
                     article_version: int | None = None) -> dict:
        if stage not in STAGES or outcome not in ("succeeded", "failed", "held"):
            raise LedgerError("stage outcome must be succeeded, failed, or held")
        if not isinstance(actual_cost, int) or not 0 <= actual_cost <= 9223372036854775807:
            raise LedgerError("actual cost must be a non-negative 64-bit integer")
        if outcome == "succeeded":
            output_sha256 = _require_hash(output_sha256 or "", "stage output hash")
            if error_code is not None:
                raise LedgerError("successful stage cannot have an error code")
            if stage == "prepublish":
                if not isinstance(article_id, str) or not re.fullmatch(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", article_id):
                    raise LedgerError("successful prepublish stage requires an article id")
                if not isinstance(article_version, int) or article_version < 1:
                    raise LedgerError("successful prepublish stage requires a positive article version")
            elif article_id is not None or article_version is not None:
                raise LedgerError("article version metadata is only valid for the prepublish stage")
        elif not isinstance(error_code, str) or not SAFE_CODE.fullmatch(error_code):
            raise LedgerError("failed or held stages require a short non-sensitive error code")
        elif article_id is not None or article_version is not None:
            raise LedgerError("failed or held stages cannot record a published article version")
        now = _now()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            run = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            current = conn.execute("SELECT * FROM stages WHERE run_id = ? AND name = ?", (run_id, stage)).fetchone()
            if not run or not current or current["state"] != "running":
                raise LedgerError("stage is not running")
            reserved = current["reserved_cost"]
            other_reserved = run["budget_reserved"] - reserved
            over_budget = run["budget_spent"] + other_reserved + actual_cost > run["budget_limit"]
            final_state = "held" if over_budget else outcome
            run_state = "budget_held" if over_budget else {"succeeded": "ready", "failed": "ready", "held": "held"}[outcome]
            if outcome == "succeeded":
                remaining = conn.execute("SELECT count(*) AS n FROM stages WHERE run_id=? AND state<>'succeeded' AND name<>?",
                                         (run_id, stage)).fetchone()["n"]
                if remaining == 0:
                    run_state = "complete"
            if outcome == "failed" and current["attempts"] >= run["max_attempts"]:
                run_state = "failed"
            if over_budget:
                error_code = "budget_exceeded"
            conn.execute(
                "UPDATE stages SET state=?,actual_cost=?,reserved_cost=0,output_sha256=?,error_code=?,updated_at=? WHERE run_id=? AND name=?",
                (final_state, actual_cost, output_sha256, error_code, now, run_id, stage),
            )
            conn.execute(
                "UPDATE runs SET state=?,budget_spent=budget_spent+?,budget_reserved=budget_reserved-?,article_id=COALESCE(?,article_id),article_version=COALESCE(?,article_version),updated_at=? WHERE run_id=?",
                (run_state, actual_cost, reserved, article_id, article_version, now, run_id),
            )
            conn.execute("INSERT INTO events (run_id,stage,kind,from_state,to_state,attempt,cost,model_id,input_sha256,output_sha256,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (run_id, stage, "stage_finished", "running", final_state, current["attempts"],
                          actual_cost, current["model_id"], current["input_sha256"], output_sha256,
                          error_code, now))
            conn.commit()
            return {"run_id": run_id, "stage": stage, "stage_state": final_state,
                    "run_state": run_state, "budget_spent": run["budget_spent"] + actual_cost}

    def record_selection(self, run_id: str, *, decision: str, topic_key: str,
                         article_id: str | None) -> dict:
        """Remember what topic selection chose, once per run, so later runs can avoid repeating it."""
        if decision not in SELECTION_DECISIONS:
            raise LedgerError("unknown topic selection decision")
        topic_key = _require_key(topic_key, "topic key")
        if article_id is not None and not re.fullmatch(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", article_id):
            raise LedgerError("article id must be a lowercase slug")
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            stage = conn.execute("SELECT state FROM stages WHERE run_id=? AND name='topic_selection'",
                                 (run_id,)).fetchone()
            if not stage or stage["state"] != "succeeded":
                raise LedgerError("topic selection must succeed before its decision is recorded")
            old = conn.execute("SELECT * FROM selections WHERE run_id=?", (run_id,)).fetchone()
            if old:
                if (old["decision"], old["topic_key"], old["article_id"]) != (decision, topic_key, article_id):
                    raise LedgerError("this run already recorded a different topic selection")
                conn.commit()
                return dict(old)
            conn.execute("INSERT INTO selections (run_id,decision,topic_key,article_id,created_at) VALUES (?,?,?,?,?)",
                         (run_id, decision, topic_key, article_id, _now()))
            row = conn.execute("SELECT * FROM selections WHERE run_id=?", (run_id,)).fetchone()
            conn.commit()
            return dict(row)

    def selections(self, *, exclude_run: str | None = None) -> list[dict]:
        """Earlier selections with their run state; no article text is stored here."""
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT s.run_id,s.decision,s.topic_key,s.article_id,s.created_at,r.state AS run_state,r.input_ref "
                "FROM selections s JOIN runs r USING (run_id) WHERE s.run_id IS NOT ? ORDER BY s.created_at",
                (exclude_run,)).fetchall()
            return [dict(row) for row in rows]

    def close_run(self, run_id: str, state: str, error_code: str) -> dict:
        """End a ready run without an article: no qualifying topic, or held for an operator."""
        if state not in ("no_topic", "held"):
            raise LedgerError("a run can only be closed as no_topic or held")
        if not SAFE_CODE.fullmatch(error_code or ""):
            raise LedgerError("closing a run requires a short non-sensitive code")
        now = _now()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not run:
                raise LedgerError("unknown run")
            if run["state"] == state:
                conn.commit()
                return self._run_view(run)
            if run["state"] != "ready":
                raise LedgerError(f"run cannot be closed while {run['state']}")
            conn.execute("UPDATE runs SET state=?,updated_at=? WHERE run_id=?", (state, now, run_id))
            conn.execute("INSERT INTO events (run_id,kind,from_state,to_state,error_code,created_at) VALUES (?,?,?,?,?,?)",
                         (run_id, "closed", run["state"], state, error_code, now))
            row = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            conn.commit()
            return self._run_view(row)

    def pause(self, run_id: str) -> dict:
        return self._set_run_state(run_id, "paused", allowed=("ready", "running"), event="paused")

    def resume(self, run_id: str) -> dict:
        now = _now()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not run or run["state"] not in ("paused", "running"):
                raise LedgerError("only paused or interrupted runs can resume")
            if run["state"] == "running":
                active = conn.execute("SELECT * FROM stages WHERE run_id=? AND state='running'", (run_id,)).fetchone()
                if not active:
                    raise LedgerError("running record has no interrupted stage")
                conn.execute("UPDATE stages SET state='failed',reserved_cost=0,actual_cost=?,error_code='interrupted',updated_at=? WHERE run_id=? AND name=?",
                             (active["reserved_cost"], now, run_id, active["name"]))
                conn.execute("UPDATE runs SET budget_spent=budget_spent+?,budget_reserved=budget_reserved-?,state='ready',updated_at=? WHERE run_id=?",
                             (active["reserved_cost"], active["reserved_cost"], now, run_id))
                conn.execute("INSERT INTO events (run_id,stage,kind,from_state,to_state,attempt,cost,model_id,input_sha256,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                             (run_id, active["name"], "interrupted", "running", "failed", active["attempts"],
                              active["reserved_cost"], active["model_id"], active["input_sha256"], "interrupted", now))
                run_state = "ready"
            else:
                conn.execute("UPDATE runs SET state='ready',updated_at=? WHERE run_id=?", (now, run_id))
                run_state = "ready"
            conn.execute("INSERT INTO events (run_id,kind,from_state,to_state,created_at) VALUES (?,?,?,?,?)",
                         (run_id, "resumed", run["state"], run_state, now))
            row = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            conn.commit()
            return self._run_view(row)

    def _set_run_state(self, run_id: str, new_state: str, *, allowed: tuple[str, ...], event: str) -> dict:
        now = _now()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not run or run["state"] not in allowed:
                raise LedgerError(f"run cannot be {event}")
            if conn.execute("SELECT 1 FROM stages WHERE run_id=? AND state='running'", (run_id,)).fetchone():
                raise LedgerError("cannot pause while a stage is running; recover it with resume after interruption")
            conn.execute("UPDATE runs SET state=?,updated_at=? WHERE run_id=?", (new_state, now, run_id))
            conn.execute("INSERT INTO events (run_id,kind,from_state,to_state,created_at) VALUES (?,?,?,?,?)",
                         (run_id, event, run["state"], new_state, now))
            row = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            conn.commit()
            return self._run_view(row)

    def show(self, run_id: str) -> dict:
        with closing(self._connect()) as conn:
            run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not run:
                raise LedgerError("unknown run")
            stages = conn.execute("SELECT name,state,attempts,reserved_cost,actual_cost,model_id,input_sha256,output_sha256,error_code FROM stages WHERE run_id=? ORDER BY ordinal",
                                  (run_id,)).fetchall()
            events = conn.execute("SELECT kind,stage,from_state,to_state,attempt,cost,reserved_cost,model_id,input_sha256,output_sha256,error_code,created_at FROM events WHERE run_id=? ORDER BY event_id",
                                  (run_id,)).fetchall()
            selection = conn.execute("SELECT decision,topic_key,article_id,created_at FROM selections WHERE run_id=?",
                                     (run_id,)).fetchone()
            return {"run": self._run_view(run), "stages": [dict(x) for x in stages],
                    "events": [dict(x) for x in events],
                    "selection": dict(selection) if selection else None}
