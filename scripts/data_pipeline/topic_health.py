"""Whether topics are still being fed, and which ones need a person: `pnpm data:topics:health`.

Topics grow from two sources: the posts of each daily window, and the searches made
for the topics that most need another voice (`topic-queries` -> `crawl search` ->
`topic-searched`). The second gave most of the claims and nearly every topic argued
both ways; when it stopped being run by hand on 2026-10-11, topics slowed to a few a
week without anything failing. This module reads the database and the daily records
and says, in four kinds, what needs a look:

- `pipeline`: a topic step did not run or failed - mining older than 36 hours, no
  search for 72 hours, a failed batch, a failed evidence run, a topic step of the
  latest daily window that did not finish.
- `stalled`: no new topic in 7 days, or fewer than 10 claims placed in 7 days.
- `evidence`: topics that searching does not move - one-sided after three searches
  and two weeks, or with no new claim for 45 days.
- `review`: topics only a person can settle - one that fails its own standard, or two
  whose objects look like one question ("manager" / "middle manager").

Each kind is one GitHub Issue at most, labelled `topic-health`, found again by a
marker in its body: opened when the kind is found, its body rewritten while it lasts
(a silent edit), reopened if it comes back within a week of closing, and closed with
a comment once the condition is gone. A person who has looked at an item and decided
it is fine records that with `--resolve KEY --reason ...` (kept in
data/topics/health-reviewed.json); a resolved item is not listed again.

Nothing here changes a topic, and nothing in an Issue is more than what the site
already publishes: questions, ids, counts, run ids.
"""

import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import topic_mining

KINDS = ("pipeline", "stalled", "evidence", "review")
LABEL = "topic-health"
MINING_STALE = timedelta(hours=36)
SEARCH_STALE = timedelta(hours=72)
WEEK = timedelta(days=7)
MIN_NEW_TOPICS_A_WEEK, MIN_CLAIMS_A_WEEK = 1, 10
ONE_SIDED_SEARCHES, ONE_SIDED_AGE = 3, timedelta(days=14)
QUIET = timedelta(days=45)
REOPEN_WITHIN = timedelta(days=7)
TOPIC_STEPS = ("topic-queries", "topic-search", "topic-searched", "mine-topics", "topic-evidence")
MARKER = re.compile(r"<!-- topic-health:(\w+) first-seen=(\S+) -->")


def _at(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    return value.astimezone(timezone.utc)


def _hours(now, then):
    return None if then is None else round((now - then).total_seconds() / 3600, 1)


def _words(text):
    return " " + re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip() + " "


def duplicate_pairs(topics):
    """Topics of one kind whose object holds the other's as whole words: one question asked twice, perhaps."""
    pairs = []
    for a in topics:
        for b in topics:
            if a is not b and a["question_type"] == b["question_type"] and _words(a["object"]).strip() \
                    and _words(a["object"]) in _words(b["object"]):
                pairs.append((a, b))
    return pairs


def latest_daily_record(daily_dir):
    """The record of the newest daily window that has one, with its tag; (None, {}) when there is none."""
    records = sorted(Path(daily_dir).glob("*/record.json")) if daily_dir else []
    for path in reversed(records):
        try:
            return path.parent.name, json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return None, {}


def load_reviewed(path):
    try:
        return {row["key"]: row for row in json.loads(Path(path).read_text(encoding="utf-8"))}
    except FileNotFoundError:
        return {}


def resolve(path, key, reason, now):
    """Record that a person looked at an item and settled it; the file only grows."""
    if not reason.strip():
        raise ValueError("--resolve needs --reason")
    path = Path(path)
    rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    rows.append({"key": key, "reason": reason, "at": now.isoformat()})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"resolved": key, "items": len(rows)}


def readings(conn, now, daily_dir=None):
    """What the database and the latest daily window say about topics, as plain values."""
    runs = conn.execute("SELECT run_id, ingested_at, counts FROM topic_mining_runs ORDER BY ingested_at DESC").fetchall()
    week = [r for r in runs if _at(r["ingested_at"]) >= now - WEEK]
    topics = [topic_mining.describe(t) for t in topic_mining.load_topics(conn)]
    searched = {r["topic_id"]: r for r in conn.execute(
        "SELECT topic_id, count(DISTINCT collection_run_id) AS runs, max(searched_at) AS at "
        "FROM topic_searches GROUP BY topic_id").fetchall()}
    last_search = max((_at(r["at"]) for r in searched.values()), default=None)
    evidence = conn.execute(
        "SELECT run_id, status, started_at FROM judgment_runs WHERE task = 'answer_evidence' "
        "ORDER BY started_at DESC LIMIT 1").fetchone()
    tag, record = latest_daily_record(daily_dir)
    steps = record.get("steps") or {}
    latest = runs[0] if runs else None
    opened = [_at(t["opened_at"]) for t in topics]
    return {
        "checked_at": now.isoformat(),
        "topics": len(topics),
        "topics_by_status": {s: sum(1 for t in topics if t["status"] == s) for s in ("open", "one_sided", "fails")},
        "topics_unanchored": sum(1 for t in topics if not t["anchor"]),
        "latest_mining_run": latest and latest["run_id"],
        "hours_since_mining": _hours(now, latest and _at(latest["ingested_at"])),
        "latest_batches_failed": int((latest and latest["counts"].get("batches_failed")) or 0),
        "mining_runs_7d": len(week),
        "claims_7d": sum(int(r["counts"].get("claims") or 0) for r in week),
        "new_topics_7d": sum(1 for at in opened if at >= now - WEEK),
        "last_topic_opened_at": max(opened).isoformat() if opened else None,
        "last_search_at": last_search and last_search.isoformat(),
        "hours_since_search": _hours(now, last_search),
        "topics_ever_searched": len(searched),
        "latest_evidence_run": evidence and {"run_id": evidence["run_id"], "status": evidence["status"]},
        "daily_window": tag,
        "daily_topic_steps": {name: {"finished": steps[name]["finished"], "exit": steps[name]["exit"]}
                              for name in TOPIC_STEPS if name in steps},
        # Kept for the lists below; not part of what is printed.
        "_topics": topics, "_searched": searched,
    }


def _row(topic, note):
    return {"topic": topic["id"], "question": topic["question"]["zh-CN"], "status": topic["status"],
            "accounts": topic["accounts"], "note": note}


def findings(r, now, reviewed=None):
    """kind -> {"reasons": [...], "items": [...]} for every kind found; a kind not found is absent."""
    reviewed = reviewed or {}
    found = {}
    reasons = []
    if r["hours_since_mining"] is None or r["hours_since_mining"] > MINING_STALE.total_seconds() / 3600:
        reasons.append(f"话题挖掘 {r['hours_since_mining']} 小时没有运行（阈值 {MINING_STALE.total_seconds() / 3600:.0f} 小时）")
    if r["latest_batches_failed"]:
        reasons.append(f"最近一次挖掘 {r['latest_mining_run']} 有 {r['latest_batches_failed']} 批读取失败")
    if r["hours_since_search"] is None or r["hours_since_search"] > SEARCH_STALE.total_seconds() / 3600:
        reasons.append(f"搜索回流 {r['hours_since_search']} 小时没有运行（阈值 {SEARCH_STALE.total_seconds() / 3600:.0f} 小时，"
                       f"最近一次 {r['last_search_at']}）")
    if r["latest_evidence_run"] and r["latest_evidence_run"]["status"] == "failed":
        reasons.append(f"最近一次证据判断 {r['latest_evidence_run']['run_id']} 失败（Jev 不可用）")
    for name, step in r["daily_topic_steps"].items():
        if not step["finished"]:
            reasons.append(f"每日窗口 {r['daily_window']} 的步骤 {name} 未完成（退出码 {step['exit']}）")
    if reasons:
        found["pipeline"] = {"reasons": reasons, "items": []}

    reasons = []
    if r["new_topics_7d"] < MIN_NEW_TOPICS_A_WEEK:
        reasons.append(f"7 天内新增话题 {r['new_topics_7d']} 个（阈值至少 {MIN_NEW_TOPICS_A_WEEK}），"
                       f"最近一个开于 {r['last_topic_opened_at']}")
    if r["claims_7d"] < MIN_CLAIMS_A_WEEK:
        reasons.append(f"7 天内 {r['mining_runs_7d']} 次挖掘共归入主张 {r['claims_7d']} 条（阈值至少 {MIN_CLAIMS_A_WEEK}）")
    if reasons:
        found["stalled"] = {"reasons": reasons, "items": []}

    items = []
    for t in r["_topics"]:
        searches = r["_searched"].get(t["id"], {}).get("runs", 0)
        last_claim = max((_at(c["published_at"]) for c in t["claims"]), default=None)
        if t["status"] == "one_sided" and searches >= ONE_SIDED_SEARCHES and _at(t["opened_at"]) <= now - ONE_SIDED_AGE:
            items.append({**_row(t, f"搜过 {searches} 次仍只有一边有人主张"), "key": f"one_sided:{t['id']}"})
        elif t["status"] != "fails" and last_claim and last_claim <= now - QUIET:
            items.append({**_row(t, f"{(now - last_claim).days} 天没有新主张，可转为 dormant"), "key": f"quiet:{t['id']}"})
    items = [i for i in items if i["key"] not in reviewed]
    if items:
        found["evidence"] = {"reasons": [f"{len(items)} 个话题搜索也补不出另一边或长期无人讨论"], "items": items}

    items = [{**_row(t, "未通过话题标准（" + "、".join(k for k in topic_mining.CHECKS if not t["checks"].get(k)) + "）"),
              "key": f"fails:{t['id']}"} for t in r["_topics"] if t["status"] == "fails"]
    for a, b in duplicate_pairs(r["_topics"]):
        items.append({**_row(b, f"对象「{b['object']}」包含「{a['object']}」（{a['id']}），可能是同一问题"),
                      "key": f"duplicate:{a['id']},{b['id']}"})
    items = [i for i in items if i["key"] not in reviewed]
    if items:
        found["review"] = {"reasons": [f"{len(items)} 项需要人判断：疑似重复或未通过标准"], "items": items}
    return found


TITLES = {
    "pipeline": "话题监控：话题链路未运行或失败",
    "stalled": "话题监控：话题断更",
    "evidence": "话题监控：话题证据不足",
    "review": "话题监控：话题需人工判断",
}
ACTIONS = {
    "pipeline": "查看最近每日窗口的话题步骤日志；修复后下一轮 `pnpm data:daily` 会自动补跑搜索与挖掘。"
                "需要立即补跑时按 docs/development/local-data-pipeline.md 的「话题持续更新与监控」手动执行。",
    "stalled": "先看 pipeline 类 Issue 是否同时打开；链路正常时检查采集量、主张读取提示词和搜索词质量，"
               "必要时用 `pnpm data:topics:queries` 扩大搜索。",
    "evidence": "逐个判断：改写选项或搜索词、保留为一边倒、或将话题转为 dormant。判断后执行 "
                "`pnpm data:topics:health -- --resolve <key> --reason \"…\"`，该项不再列出。",
    "review": "逐项判断：疑似重复的话题是否合并、未通过标准的话题是否改写或关闭。判断后执行 "
              "`pnpm data:topics:health -- --resolve <key> --reason \"…\"`，该项不再列出。",
}
CLOSE_WHEN = {
    "pipeline": "最近一次挖掘不超过 36 小时、最近一次搜索不超过 72 小时，且最近窗口的话题步骤与证据判断都成功。",
    "stalled": "7 天内至少新增 1 个话题且归入至少 10 条主张。",
    "evidence": "列表为空（话题被搜出另一边、有新主张，或已逐项 resolve）。",
    "review": "列表为空（已合并、改写、关闭，或已逐项 resolve）。",
}
SHOWN = ("topics", "topics_by_status", "topics_unanchored", "latest_mining_run", "hours_since_mining",
         "mining_runs_7d", "claims_7d", "new_topics_7d", "last_topic_opened_at", "last_search_at",
         "hours_since_search", "topics_ever_searched", "latest_evidence_run", "daily_window")


def render(kind, finding, r, first_seen):
    """The Issue body: the same fields every time, so an edit shows only what moved."""
    lines = [f"<!-- topic-health:{kind} first-seen={first_seen} -->",
             f"**类型**：`{kind}` · {TITLES[kind].split('：', 1)[1]}",
             f"**状态**：触发中 · 首次发现 {first_seen} · 最近检查 {r['checked_at']}",
             "", "**触发原因**", *[f"- {reason}" for reason in finding["reasons"]]]
    if finding["items"]:
        lines += ["", f"**涉及话题**（{len(finding['items'])}）", "",
                  "| key | 问题 | 状态 | 账号 | 说明 |", "| --- | --- | --- | --- | --- |"]
        for item in finding["items"][:50]:
            lines.append(f"| `{item['key']}` | {item['question']} | {item['status']} | {item['accounts']} | {item['note']} |")
        if len(finding["items"]) > 50:
            lines.append(f"| … | 另有 {len(finding['items']) - 50} 项未列出 | | | |")
    lines += ["", "**当前读数**", "", "| 读数 | 值 |", "| --- | --- |",
              *[f"| {key} | {json.dumps(r[key], ensure_ascii=False)} |" for key in SHOWN],
              "", f"**建议处理**：{ACTIONS[kind]}",
              "", f"**自动关闭条件**：{CLOSE_WHEN[kind]}",
              "", "_由 `pnpm data:topics:health --issues` 维护（每日数据运行的最后一步）。"
                  "同类只保留一个 Issue：持续期间改写正文，条件解除后自动评论并关闭。_"]
    return "\n".join(lines)


class GitHub:
    """The few `gh` calls the sync needs; `run(argv) -> stdout` is injectable for tests."""

    def __init__(self, repo="feyn-machines/surviagi", run=None):
        self.repo = repo
        self.run = run or (lambda argv: subprocess.run(argv, check=True, text=True, capture_output=True).stdout)

    def issues(self):
        out = self.run(["gh", "issue", "list", "-R", self.repo, "--label", LABEL, "--state", "all",
                        "--limit", "100", "--json", "number,state,body,closedAt"])
        return json.loads(out or "[]")

    def ensure_label(self):
        self.run(["gh", "label", "create", LABEL, "-R", self.repo, "--force", "--color", "c5def5",
                  "--description", "话题产出监控自动维护的 Issue"])

    def create(self, title, body):
        return self.run(["gh", "issue", "create", "-R", self.repo, "--title", title, "--body", body,
                         "--label", LABEL]).strip()

    def edit(self, number, body):
        self.run(["gh", "issue", "edit", str(number), "-R", self.repo, "--body", body])

    def comment(self, number, body):
        self.run(["gh", "issue", "comment", str(number), "-R", self.repo, "--body", body])

    def close(self, number, comment):
        self.run(["gh", "issue", "close", str(number), "-R", self.repo, "--reason", "completed", "--comment", comment])

    def reopen(self, number, comment):
        self.run(["gh", "issue", "reopen", str(number), "-R", self.repo, "--comment", comment])


def sync(found, r, gh, now, only=None, dry_run=False):
    """Bring the topic-health Issues in line with `found`; returns what was (or would be) done."""
    kinds = [k for k in KINDS if not only or k in only]
    existing = {}
    for issue in gh.issues():
        match = MARKER.search(issue.get("body") or "")
        if match and match.group(1) in kinds:
            # The open one wins; otherwise the most recently closed.
            known = existing.get(match.group(1))
            if known is None or issue["state"] == "OPEN" or (
                    known["state"] != "OPEN" and (issue.get("closedAt") or "") > (known.get("closedAt") or "")):
                existing[match.group(1)] = {**issue, "first_seen": match.group(2)}
    actions, labelled = [], False
    for kind in kinds:
        issue, finding = existing.get(kind), found.get(kind)
        is_open = issue is not None and issue["state"] == "OPEN"
        if finding:
            recent = issue is not None and not is_open and issue.get("closedAt") and \
                now - _at(issue["closedAt"].replace("Z", "+00:00")) <= REOPEN_WITHIN
            first_seen = issue["first_seen"] if is_open or recent else now.strftime("%Y-%m-%dT%H:%MZ")
            body = render(kind, finding, r, first_seen)
            if is_open:
                if body.split("\n", 3)[3] != (issue.get("body") or "").split("\n", 3)[-1]:
                    actions.append({"kind": kind, "do": "edit", "issue": issue["number"]})
                    if not dry_run:
                        gh.edit(issue["number"], body)
            elif recent:
                actions.append({"kind": kind, "do": "reopen", "issue": issue["number"]})
                if not dry_run:
                    gh.reopen(issue["number"], "再次触发：" + "；".join(finding["reasons"]))
                    gh.edit(issue["number"], body)
            else:
                actions.append({"kind": kind, "do": "create", "title": TITLES[kind]})
                if not dry_run:
                    if not labelled:
                        gh.ensure_label()
                        labelled = True
                    actions[-1]["url"] = gh.create(TITLES[kind], body)
        elif is_open:
            actions.append({"kind": kind, "do": "close", "issue": issue["number"]})
            if not dry_run:
                gh.close(issue["number"], f"条件已解除，自动关闭（检查于 {r['checked_at']}）：{CLOSE_WHEN[kind]}")
    return actions


def report(conn, now=None, daily_dir=None, reviewed_path=None, issues=False, only=None, dry_run=False, gh=None):
    """The command's result: readings, what was found, and what was done on GitHub."""
    now = now or datetime.now(timezone.utc)
    r = readings(conn, now, daily_dir)
    found = findings(r, now, load_reviewed(reviewed_path) if reviewed_path else {})
    result = {**{k: v for k, v in r.items() if not k.startswith("_")},
              "alerts": {kind: f["reasons"] for kind, f in found.items()}}
    if issues:
        result["issues"] = sync(found, r, gh or GitHub(), now, only=only, dry_run=dry_run)
    return result
