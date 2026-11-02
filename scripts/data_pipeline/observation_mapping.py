"""Which catalog entries an observation is about, and which observations are one (Issue #25).

An observation is read with its work in the model's own words ("customer
support", "software auditing"); the pages and the queries count by catalog
entry. This pass puts each observation on the market work items, occupations
and O*NET tasks it concerns:

  a local embedding shortlists the entries worth showing (10 work items, 8
  occupations, then 12 tasks of those occupations), and a model picks among
  them, or none (rule:work-mapping-stays-a-candidate). What it picks is a
  proposal and stays a candidate; an observation that fits nothing keeps
  work_key 'unmapped' rather than taking the nearest entry.

Its work_key then becomes the first work item picked, else the first
occupation. Two observations with the same actor, subject, work_key and day are
one observation (rule:observation-is-one-actor-one-subject-one-work): the later
one is merged into the earlier, keeps its id and rows, and its id becomes a
redirect (observation_merges). Before mapping the same fact read twice in other
words had two ids; this is where they meet. Read twice, a post may once give a
day and once not; the one without a day meets the other through the post.

  choose        (pure: a model's answer -> the entries kept)
  work_key_of   (pure: entries kept -> the work_key)
  merge_groups  (pure: observations -> which merge into which)
  map_observations (calls the model, then writes in one transaction)
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from secrets import token_hex

from . import deepseek, embedding
from .observation_store import _short_hash, new_facts
from .pipeline import digest

MAPPER = "observation-mapping-1"
UNMAPPED = "unmapped"
SHORTLIST = {"work": 10, "occupations": 8, "tasks": 12}
LIMITS = {"work": 2, "occupations": 2, "tasks": 3}

PROMPT = """An observation says that someone used AI on a piece of work. Say which entries of our catalog that work is.

You are given the observation and three shortlists, one entry per line as `id | name`:
- Work items: work a business does or sells, written as "work item (market)".
- Occupations: jobs people hold (O*NET).
- Tasks: O*NET tasks of those occupations, written as "task (occupation)".

Pick the entries whose work is the work the observation shows being done, judged on the work itself, not on shared words. The work is what the AI did, not the work of whoever responds to it: an attack carried out with AI is not security monitoring, and fraud is not fraud investigation. A count or projection about jobs, adoption or spending across the whole economy is not the work of the people who make such counts. Pick at most 2 work items, at most 2 occupations and at most 3 tasks; pick a task only when you also pick its occupation. Leave a list empty when nothing in it fits, and leave every list empty when the observation shows no particular kind of paid work (a speed or throughput measurement, a leaderboard rank with no task, a chat, a toy demo). A wrong match is worse than none.

Return JSON: {"work": [{"id": an id from the work shortlist, "why": a few words}], "occupations": [{"id": ..., "why": ...}], "tasks": [{"id": ..., "why": ...}]}."""


def prompt_sha256():
    return digest({"system": PROMPT, "mapper": MAPPER, "shortlist": SHORTLIST, "limits": LIMITS})


def pending(conn, mapper=MAPPER, limit=None):
    """Observations this mapper has not looked at: not merged away, not rejected by a
    person, with the work in the words of the latest run that read them."""
    return conn.execute(
        """SELECT o.observation_id, o.actor_name, o.actor_role, o.subject_key, o.task, o.evidence_type,
                  r.work, r.subject,
                  (SELECT s.quote FROM observation_sources s WHERE s.observation_id = o.observation_id
                    ORDER BY s.published_at NULLS LAST, s.source_ref LIMIT 1) AS quote
             FROM observations o
             JOIN LATERAL (SELECT rd.work, rd.subject FROM observation_readings rd
                             JOIN observation_runs ru ON ru.run_id = rd.run_id
                            WHERE rd.observation_id = o.observation_id
                            ORDER BY ru.started_at DESC LIMIT 1) r ON true
            WHERE o.review_state <> 'human_rejected'
              AND NOT EXISTS (SELECT 1 FROM observation_merges m WHERE m.observation_id = o.observation_id)
              AND NOT EXISTS (SELECT 1 FROM observation_mapping_checked c
                               WHERE c.observation_id = o.observation_id AND c.mapper = %s)
            ORDER BY o.created_at, o.observation_id
            LIMIT %s""", (mapper, limit)).fetchall()


def catalog(conn):
    """Work items (with their market), occupations that have tasks, and those tasks."""
    version = conn.execute("SELECT max(ontology_version) AS v FROM ontology_concepts").fetchone()["v"]
    work = {r["id"]: f"{r['label']} ({r['market']})" for r in conn.execute(
        """SELECT w.id, w.label_en AS label, m.label_en AS market
             FROM ontology_relations r
             JOIN ontology_concepts w ON w.id = r.child_id AND w.ontology_version = r.ontology_version
             JOIN ontology_concepts m ON m.id = r.parent_id AND m.ontology_version = r.ontology_version
            WHERE r.kind = 'has_work' AND r.ontology_version = %s""", (version,)).fetchall()}
    occupations, tasks = {}, {}
    for r in conn.execute(
            """SELECT o.id AS occupation_id, o.label_en AS occupation, t.id AS task_id, t.label_en AS task
                 FROM ontology_relations r
                 JOIN ontology_concepts o ON o.id = r.parent_id AND o.ontology_version = r.ontology_version
                 JOIN ontology_concepts t ON t.id = r.child_id AND t.ontology_version = r.ontology_version
                WHERE r.kind = 'has_task' AND r.ontology_version = %s
                ORDER BY o.id, t.id""", (version,)).fetchall():
        occupations[r["occupation_id"]] = r["occupation"]
        tasks.setdefault(r["occupation_id"], {})[r["task_id"]] = f"{r['task']} ({r['occupation']})"
    return work, occupations, tasks


def observation_text(observation):
    return f"{observation['work']}: {observation['task']}"


def user_message(observation, offered, labels):
    lines = ["Observation:", json.dumps({
        "who": observation["actor_name"], "role": observation["actor_role"],
        "used": observation["subject"] or observation["subject_key"], "work": observation["work"],
        "task": observation["task"], "evidence": observation["evidence_type"],
        "quote": (observation["quote"] or "")[:400]}, ensure_ascii=False)]
    for section, title in (("work", "Work items"), ("occupations", "Occupations"), ("tasks", "Tasks")):
        lines += ["", f"{title}:"] + [f"{cid} | {labels[cid]}" for cid in offered[section]]
    return "\n".join(lines)


def choose(result, offered, task_occupation):
    """The entries a model's answer names, kept only when they were offered in that
    section, at most LIMITS of each; a task only under an occupation also kept."""
    picked = {}
    for section in ("work", "occupations", "tasks"):
        kept, seen = [], set()
        for entry in (result or {}).get(section) or []:
            if isinstance(entry, dict) and entry.get("id") in offered[section] and entry["id"] not in seen:
                seen.add(entry["id"])
                kept.append({"id": entry["id"], "why": str(entry.get("why") or "")[:200]})
        picked[section] = kept[:LIMITS[section]]
    chosen = {entry["id"] for entry in picked["occupations"]}
    picked["tasks"] = [entry for entry in picked["tasks"] if task_occupation.get(entry["id"]) in chosen]
    return picked


def work_key_of(picked):
    for section in ("work", "occupations"):
        if picked[section]:
            return picked[section][0]["id"]
    return UNMAPPED


def merge_groups(rows):
    """[(head, member)] for observations that are one: same actor, subject and mapped
    work_key, and the same day. A day the source does not state is only the day it
    was published, so an observation without a stated day is also the same as one
    that shares a source with it, whatever day that one states; two different
    stated days stay apart. The head is the earliest written, so an id once shown
    keeps standing; a row already merged is never a head."""
    groups = {}
    for row in rows:
        if row["work_key"] != UNMAPPED:
            groups.setdefault((row["actor_key"], row["subject_key"], row["work_key"]), []).append(row)
    pairs = []
    for members in groups.values():
        members.sort(key=lambda r: (r["created_at"], r["observation_id"]))
        facts = []
        for row in members:
            for fact in facts:
                stated = row["occurred_on"]
                if stated and fact["stated"] and stated not in fact["stated"]:
                    continue
                if row["day"] in fact["days"] or fact["urls"] & set(row["urls"]):
                    pairs.append((fact["head"], row["observation_id"]))
                    fact["days"].add(row["day"])
                    fact["urls"] |= set(row["urls"])
                    fact["stated"] |= {stated} if stated else set()
                    break
            else:
                facts.append({"head": row["observation_id"], "days": {row["day"]}, "urls": set(row["urls"]),
                              "stated": {row["occurred_on"]} if row["occurred_on"] else set()})
    return pairs


def _ask(observation, offered, labels, task_occupation, cfg, usage):
    messages = [{"role": "system", "content": PROMPT},
                {"role": "user", "content": user_message(observation, offered, labels)}]
    for attempt in range(3):
        try:
            return choose(deepseek.chat(messages, cfg, usage=usage), offered, task_occupation)
        except deepseek.DeepSeekError:
            time.sleep(2 * (attempt + 1))
    return None


def map_observations(conn, cfg=None, limit=None, workers=8, plan_only=False, progress=None):
    started = datetime.now(timezone.utc)
    observations = pending(conn, limit=limit)
    counts = {"observations": len(observations), "mapped": 0, "unmapped": 0, "failed": 0, "concerns": 0,
              "merged": 0}
    if plan_only or not observations:
        return {"run_id": None, "plan_only": plan_only, **counts}
    cfg = cfg or deepseek.config_from_env()
    work, occupations, tasks = catalog(conn)
    task_occupation = {tid: oid for oid, items in tasks.items() for tid in items}
    labels = {**work, **occupations, **{tid: label for items in tasks.values() for tid, label in items.items()}}

    work_vectors = dict(zip(work, embedding.embed(list(work.values()))))
    occupation_vectors = dict(zip(occupations, embedding.embed(list(occupations.values()))))
    vectors = embedding.embed([observation_text(o) for o in observations])
    near_occupations = [[cid for cid, _ in embedding.nearest(v, occupation_vectors, SHORTLIST["occupations"])]
                        for v in vectors]
    # Tasks only of the occupations some observation came near, embedded once each.
    needed = sorted({tid for near in near_occupations for oid in near for tid in tasks[oid]})
    task_vectors = dict(zip(needed, embedding.embed([labels[tid] for tid in needed])))

    offers = []
    for vector, near in zip(vectors, near_occupations):
        pool = {tid: task_vectors[tid] for oid in near for tid in tasks[oid]}
        offers.append({"work": [cid for cid, _ in embedding.nearest(vector, work_vectors, SHORTLIST["work"])],
                       "occupations": near,
                       "tasks": [cid for cid, _ in embedding.nearest(vector, pool, SHORTLIST["tasks"])]})

    usage, done = [], [0]

    def ask(pair):
        observation, offered = pair
        picked = _ask(observation, offered, labels, task_occupation, cfg, usage)
        done[0] += 1
        if progress:
            progress(done[0], len(observations))
        return picked

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        answers = list(pool.map(ask, zip(observations, offers)))

    run_id = f"mapping-{started:%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(7543026)")
        conn.execute(
            """INSERT INTO observation_mapping_runs
               (run_id, mapper, model, embedding_model, prompt_sha256, counts, started_at)
               VALUES (%s, %s, %s, %s, %s, '{}'::jsonb, %s)""",
            (run_id, MAPPER, cfg["model"], embedding.config_from_env()["model"], prompt_sha256(), started))
        for observation, picked in zip(observations, answers):
            if picked is None:
                # Not looked at: it stays pending and the next run asks again.
                counts["failed"] += 1
                continue
            oid = observation["observation_id"]
            conn.execute("INSERT INTO observation_mapping_checked (observation_id, mapper, run_id) VALUES (%s, %s, %s)",
                         (oid, MAPPER, run_id))
            key = work_key_of(picked)
            counts["mapped" if key != UNMAPPED else "unmapped"] += 1
            for section in ("work", "occupations", "tasks"):
                for entry in picked[section]:
                    counts["concerns"] += conn.execute(
                        """INSERT INTO observation_concepts (observation_id, concept_id, method, status, rationale)
                           VALUES (%s, %s, 'ai_proposed', 'candidate', %s) ON CONFLICT DO NOTHING""",
                        (oid, entry["id"], entry["why"])).rowcount
            conn.execute("UPDATE observations SET work_key = %s WHERE observation_id = %s", (key, oid))
        counts["merged"] = merge(conn, run_id)
        counts["usd"] = round(deepseek.billed_usd(usage), 4)
        conn.execute("UPDATE observation_mapping_runs SET counts = %s, finished_at = now() WHERE run_id = %s",
                     (json.dumps(counts), run_id))
    return {"run_id": run_id, **counts}


def merge(conn, run_id):
    """Merge observations that mapping made one. Returns how many were merged."""
    rows = conn.execute(
        """SELECT o.observation_id, o.actor_key, o.subject_key, o.work_key, o.created_at, o.occurred_on,
                  coalesce(o.occurred_on, (o.announced_at AT TIME ZONE 'UTC')::date) AS day,
                  ARRAY(SELECT s.url FROM observation_sources s WHERE s.observation_id = o.observation_id) AS urls
             FROM observations o
            WHERE o.work_key <> %s
              AND NOT EXISTS (SELECT 1 FROM observation_merges m WHERE m.observation_id = o.observation_id)""",
        (UNMAPPED,)).fetchall()
    pairs = merge_groups(rows)
    for head, member in pairs:
        merge_one(conn, head, member, run_id)
    return len(pairs)


def merge_one(conn, head, member, run_id):
    """Write the member's sources, facts and entries under the head as well, and
    record the member's id as a redirect to the head. The member's rows stay; a
    number the head already has in another form is not copied."""
    for source in conn.execute("SELECT * FROM observation_sources WHERE observation_id = %s", (member,)).fetchall():
        conn.execute(
            """INSERT INTO observation_sources (source_ref, observation_id, source_type, url, source_id, quote,
                                                published_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
            ("obs-src-" + _short_hash(head, source["url"]), head, source["source_type"], source["url"],
             source["source_id"], source["quote"], source["published_at"]))
    facts = conn.execute(
        "SELECT * FROM observation_facts WHERE observation_id = %s ORDER BY fact_id", (member,)).fetchall()
    for fact in new_facts(conn, [{**fact, "observation_id": head} for fact in facts]):
        conn.execute(
            """INSERT INTO observation_facts (fact_id, observation_id, value, unit, what, baseline, method_note, quote)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
            ("fact-" + _short_hash(head, fact["value"], fact["unit"], fact["what"], fact["quote"]), head,
             fact["value"], fact["unit"], fact["what"], fact["baseline"], fact["method_note"], fact["quote"]))
    conn.execute(
        """INSERT INTO observation_concepts (observation_id, concept_id, method, status, rationale)
           SELECT %s, concept_id, method, status, rationale FROM observation_concepts WHERE observation_id = %s
           ON CONFLICT DO NOTHING""", (head, member))
    # Anything already redirected to the member now points at the head.
    conn.execute("UPDATE observation_merges SET merged_into = %s WHERE merged_into = %s", (head, member))
    conn.execute("INSERT INTO observation_merges (observation_id, merged_into, run_id) VALUES (%s, %s, %s)",
                 (member, head, run_id))
