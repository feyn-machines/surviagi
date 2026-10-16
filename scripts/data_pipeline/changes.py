"""What changed between two published releases, written as material for an article.

Pure functions over two snapshot payloads (the shape `publish-snapshot` writes and
`kg.load_release` returns); `scripts/data-changes.py` loads them. Nothing here is a
finding: every level, edge and topic in a release is machine-proposed and unreviewed,
and the brief says so. Original titles and questions are quoted as published.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

from . import ontology_schema

TOP_UPDATES = 10
UPDATES_PER_ORG = 8
TOPICS_LISTED = 15
MODELS_LISTED = 30


def _by(rows, key):
    return {row[key]: row for row in rows or [] if row.get(key) is not None}


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _engagement(event):
    return ((event.get("attention") or {}).get("engagement")) or 0


def _day(value):
    return (value or "")[:10] or "日期不明"


def _url(event):
    urls = event.get("source_urls") or []
    return urls[0] if urls else None


def kind_label(kind):
    """The Chinese label of an event kind, retired ones included; the id when the schema lacks it."""
    if not kind:
        return "类型未定"
    body = ontology_schema.term("event_kind", kind) or {}
    return (body.get("label") or {}).get("zh-CN") or kind


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def _text(value, lang="zh-CN"):
    if isinstance(value, dict):
        return value.get(lang) or value.get("en") or ""
    return value or ""


def canonical_subjects(events):
    """subject_key -> the key it is the same subject as.

    The extractor sometimes names a subject with its maker in front ("openai-decisions-api")
    and sometimes without ("decisions-api"); identity is not touched here, the two are
    only counted as one subject. A key is folded only when the maker is a known
    organisation and the remainder is itself a key in use, so "google-workspace" stays.
    """
    keys = {e["subject_key"] for e in events if e.get("subject_key")}
    makers = set()
    for event in events:
        for name in (event.get("org_name"), (event.get("primary_org_id") or "").removeprefix("org:")):
            if name:
                makers.add(_slug(name))
    makers.discard("")
    out = {}
    for key in keys:
        target = key
        for maker in makers:
            rest = key[len(maker) + 1:] if key.startswith(maker + "-") else None
            if rest and rest in keys:
                target = rest
                break
        out[key] = target
    return out


def compare(old: dict, new: dict) -> dict:
    """Everything the brief reports, as data."""
    old_chain, new_chain = old.get("chain") or {}, new.get("chain") or {}
    old_events, new_events = _by(old.get("events"), "event_id"), _by(new.get("events"), "event_id")
    added_events = [e for eid, e in new_events.items() if eid not in old_events]
    added_events.sort(key=lambda e: (-_engagement(e), e.get("occurred_at") or "", e["event_id"]))

    old_activities = _by(old_chain.get("activities"), "activity_id")
    old_evidence = {(r["event_id"], r["activity_id"]) for r in old_chain.get("evidence") or []}
    new_evidence = defaultdict(list)
    for row in new_chain.get("evidence") or []:
        if (row["event_id"], row["activity_id"]) not in old_evidence:
            new_evidence[row["activity_id"]].append(row["event_id"])
    level_changes = []
    for activity in new_chain.get("activities") or []:
        before = old_activities.get(activity["activity_id"]) or {}
        was, now = _num(before.get("level")), _num(activity.get("level"))
        if was != now:
            level_changes.append({**activity, "was": was, "now": now,
                                  "new_events": new_evidence.get(activity["activity_id"], [])})
    level_changes.sort(key=lambda a: (-(a["now"] or 0), -((a["now"] or 0) - (a["was"] or 0)), a["activity_id"]))

    canonical = canonical_subjects(list(new_events.values()))
    series = defaultdict(list)
    for event in added_events:
        if event.get("subject_key"):
            series[canonical[event["subject_key"]]].append(event)
    series = sorted(((key, rows) for key, rows in series.items() if len(rows) > 1),
                    key=lambda item: (-len(item[1]), item[0]))

    old_topics, new_topics = _by(old.get("topics"), "topic_id"), _by(new.get("topics"), "topic_id")
    opened = [t for tid, t in new_topics.items() if tid not in old_topics]
    grown = []
    for tid, topic in new_topics.items():
        if tid in old_topics:
            gained = len(topic.get("claims") or []) - len(old_topics[tid].get("claims") or [])
            if gained > 0:
                grown.append({**topic, "gained": gained})
    opened.sort(key=lambda t: (-len(t.get("claims") or []), t["topic_id"]))
    grown.sort(key=lambda t: (-t["gained"], t["topic_id"]))

    old_models = _by(old.get("models"), "model_id")
    models = [m for mid, m in _by(new.get("models"), "model_id").items() if mid not in old_models]
    models.sort(key=lambda m: (m.get("released_at") or "", m["model_id"]), reverse=True)

    def stages(payload):
        return {row["stage"]: row["work_items"] for row in (payload.get("progress") or {}).get("global") or []
                if row.get("coverage") == "assessed"}

    return {
        "counts": {
            "updates": (len(old_events), len(new_events)),
            "updates_bearing_on_work": (len(old_chain.get("events") or []), len(new_chain.get("events") or [])),
            "readings": (len(old_chain.get("evidence") or []), len(new_chain.get("evidence") or [])),
            "work_with_evidence": tuple(sum(1 for a in (c.get("activities") or []) if _num(a.get("level")) is not None)
                                        for c in (old_chain, new_chain)),
            "topics": (len(old_topics), len(new_topics)),
            "models": (len(old_models), len(new.get("models") or [])),
        },
        "stages": (stages(old), stages(new)),
        "added_events": added_events,
        "events_by_id": new_events,
        "level_changes": level_changes,
        "series": series,
        "opened_topics": opened,
        "grown_topics": grown,
        "new_models": models,
    }


def _delta(pair):
    was, now = pair
    diff = now - was
    return f"{was} → {now}（{'+' if diff >= 0 else ''}{diff}）"


def _level(value):
    return "无" if value is None else f"L{value:g}"


def _event_line(event):
    url = _url(event)
    title = event.get("title") or event["event_id"]
    attention = (event.get("attention") or {}).get("engagement")
    tail = f"，互动 {attention}" if attention else ""
    who = event.get("org_name") or "个人或第三方"
    link = f"[{title}]({url})" if url else title
    return f"- {_day(event.get('occurred_at'))} · {who} · {link}（{kind_label(event.get('kind'))}{tail}）"


def render(result: dict, old_id: str, new_id: str) -> str:
    """The brief, in Chinese, with original titles and questions kept as published."""
    c = result["counts"]
    lines = [
        f"# 两次数据发布之间的变化：{old_id} → {new_id}",
        "",
        "> 写作素材，不是结论。所有等级、关联和话题都由机器提出、未经人工审核；标题和问题保留原文。",
        "",
        "## 概览",
        "",
        f"- 更新：{_delta(c['updates'])}",
        f"- 触及具体工作的更新：{_delta(c['updates_bearing_on_work'])}",
        f"- 证据（更新 × 工作）：{_delta(c['readings'])}",
        f"- 有等级读数的工作：{_delta(c['work_with_evidence'])}",
        f"- 话题：{_delta(c['topics'])}",
        f"- 模型：{_delta(c['models'])}",
    ]
    old_stages, new_stages = result["stages"]
    for stage in sorted(set(old_stages) | set(new_stages), key=lambda s: (s is None, s)):
        lines.append(f"- 已评估、处在第 {stage} 阶段的工作项：{_delta((old_stages.get(stage, 0), new_stages.get(stage, 0)))}")

    lines += ["", f"## 等级变化的工作（{len(result['level_changes'])} 项）", ""]
    if not result["level_changes"]:
        lines.append("没有工作的等级发生变化。")
    for activity in result["level_changes"]:
        lines.append(f"- **{activity.get('label_zh_cn') or activity.get('label_en')}**"
                     f"（{activity.get('market_zh_cn') or activity.get('market_en')}）："
                     f"{_level(activity['was'])} → {_level(activity['now'])}，最高证据档 {activity.get('best_tier') or '无'}")
        for event_id in activity["new_events"][:3]:
            event = result["events_by_id"].get(event_id)
            if event:
                lines.append("  " + _event_line(event))

    added = result["added_events"]
    lines += ["", f"## 最受关注的新更新（共 {len(added)} 条新更新，按互动排序）", ""]
    lines += [_event_line(e) for e in added[:TOP_UPDATES]] or ["没有新更新。"]

    lines += ["", "## 同一主题的多条新更新", ""]
    if not result["series"]:
        lines.append("没有主题出现两条以上的新更新。")
    for key, rows in result["series"]:
        names = sorted({r.get("subject") or key for r in rows})
        lines.append(f"- **{' / '.join(names)}**（`{key}`）：{len(rows)} 条")
        lines += ["  " + _event_line(e) for e in rows[:5]]

    lines += ["", "## 各公司的新更新", ""]
    by_org = defaultdict(list)
    for event in added:
        by_org[event.get("org_name") or "个人或第三方"].append(event)
    for org, rows in sorted(by_org.items(), key=lambda item: (-len(item[1]), item[0])):
        kinds = Counter(kind_label(r.get("kind")) for r in rows)
        lines.append(f"### {org}（{len(rows)} 条：" + "、".join(f"{k} {n}" for k, n in kinds.most_common(4)) + "）")
        lines += [_event_line(e) for e in rows[:UPDATES_PER_ORG]]
        if len(rows) > UPDATES_PER_ORG:
            lines.append(f"- ……另有 {len(rows) - UPDATES_PER_ORG} 条")
        lines.append("")

    lines += [f"## 新话题（{len(result['opened_topics'])} 个）", ""]
    for topic in result["opened_topics"][:TOPICS_LISTED] or []:
        lines.append(f"- {_text(topic.get('question'))}（{len(topic.get('claims') or [])} 条说法，{topic.get('accounts') or 0} 个账号）")
    if not result["opened_topics"]:
        lines.append("没有新话题。")
    lines += ["", f"## 说法增加最多的话题（{len(result['grown_topics'])} 个话题有新说法）", ""]
    for topic in result["grown_topics"][:TOPICS_LISTED]:
        lines.append(f"- {_text(topic.get('question'))}：+{topic['gained']} 条，共 {len(topic.get('claims') or [])} 条")
    if not result["grown_topics"]:
        lines.append("没有话题增加说法。")

    lines += ["", f"## 新模型（{len(result['new_models'])} 个）", ""]
    for model in result["new_models"][:MODELS_LISTED]:
        lines.append(f"- {model.get('owner_zh_cn') or model.get('owner') or '来源不明'} · {model.get('name')}"
                     f"（{_day(model.get('released_at'))}，{model.get('status')}）")
    if len(result["new_models"]) > MODELS_LISTED:
        lines.append(f"- ……另有 {len(result['new_models']) - MODELS_LISTED} 个")
    if not result["new_models"]:
        lines.append("没有新模型。")
    return "\n".join(lines).rstrip() + "\n"
