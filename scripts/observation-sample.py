#!/usr/bin/env python3
"""Measure what reading the collected posts for observations costs (Issue #25).

Before the history is read again (design C8), a random sample of the posts that
pass the prefilter is extracted with the prompt that also asks for observations,
and the tokens DeepSeek reports are priced. With --baseline the same posts are
also read with today's prompt, so the report shows what observations add to the
daily call. The report scales the measured cost per post to the whole history,
the last 90 days, and each group of authors, at peak and off-peak rates.

Nothing is written to the database. Output goes to an ignored directory under
data/observations/: it quotes third-party posts and stays local.

  pnpm data:observations:sample -- --size 500 --baseline
  pnpm data:observations:sample -- --sample-from data/observations/sample-20261103

--sample-from reads the very posts of an earlier sample again, so a prompt
change is compared on the same posts.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from data_pipeline import deepseek  # noqa: E402
from data_pipeline.db import connect  # noqa: E402
from data_pipeline.event_extraction import load_candidates, load_known_events  # noqa: E402
from data_pipeline.observation_extraction import EXTRACTOR, assemble_observations, prefilter  # noqa: E402


def json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=json_default) + "\n")


def group(candidate):
    return "official" if candidate.get("official") else "others"


def price_of(model):
    return deepseek.PRICES["deepseek-v4-pro" if str(model or "").startswith("deepseek-v4-pro")
                           else "deepseek-flash"]


def priced(usage):
    """Token totals and USD of a run's calls: as billed, all at peak, all off-peak."""
    totals = Counter()
    billed = peak = off_peak = 0.0
    for call in usage:
        for name in ("prompt_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
                     "completion_tokens"):
            totals[name] += call.get(name) or 0
        prices = price_of(call.get("model"))
        billed += deepseek.call_cost(call, prices, deepseek.is_peak(call["at"]))
        peak += deepseek.call_cost(call, prices, True)
        off_peak += deepseek.call_cost(call, prices, False)
    return {"calls": len(usage), "models": sorted({str(c.get("model")) for c in usage}),
            "tokens": dict(totals), "usd_billed": round(billed, 4),
            "usd_all_peak": round(peak, 4), "usd_all_off_peak": round(off_peak, 4)}


def run(sample, cfg, known, args, observations):
    usage = []
    label = "with observations" if observations else "baseline"
    batches, failures = deepseek.extract_events(
        sample, cfg, batch_size=args.batch_size, known=known, workers=args.workers,
        observations=observations, usage=usage,
        progress=lambda done, total, n: print(f"  {label} batch {done}/{total}: {n} events", file=sys.stderr))
    return batches, failures, usage


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--size", type=int, default=500)
    parser.add_argument("--seed", type=int, default=20261103)
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--baseline", action="store_true", help="also read the sample with today's prompt")
    parser.add_argument("--plan-only", action="store_true", help="count the population and stop")
    parser.add_argument("--sample-from", type=Path, help="an earlier sample directory whose posts to read again")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    deepseek.load_env(ROOT)
    now = datetime.now(timezone.utc)
    out = args.output or ROOT / "data/observations" / f"sample-{now:%Y%m%dT%H%M%SZ}"
    if out.exists():
        raise SystemExit(f"Output already exists: {out}")

    with connect() as conn:
        candidates = load_candidates(conn)
        reasons = Counter(prefilter(c) or "kept" for c in candidates)
        population = [c for c in candidates if not prefilter(c)]
        since_90 = now - timedelta(days=90)
        scopes = {
            "all": population,
            "last_90_days": [c for c in population if c["published_at"] >= since_90],
            "official": [c for c in population if c.get("official")],
            "others": [c for c in population if not c.get("official")],
        }
        counts = {
            "original_posts": len(candidates), "prefilter": dict(reasons),
            "scopes": {name: len(items) for name, items in scopes.items()},
            "by_month": dict(sorted(Counter(c["published_at"].strftime("%Y-%m") for c in population).items())),
            "first_post": min(c["published_at"] for c in population),
            "last_post": max(c["published_at"] for c in population),
        }
        print(json.dumps(counts, ensure_ascii=False, indent=2, default=json_default))
        if args.plan_only:
            return
        if args.sample_from:
            wanted = {item["source_id"] for item in json.loads((args.sample_from / "sample.json").read_text())}
            sample = [c for c in candidates if c["source_id"] in wanted]
            if len(sample) != len(wanted):
                raise SystemExit(f"{len(wanted) - len(sample)} posts of {args.sample_from} are no longer candidates")
        else:
            sample = random.Random(args.seed).sample(population, min(args.size, len(population)))
        sample.sort(key=lambda c: (c["published_at"], c["source_id"]))
        known = load_known_events(conn, sample)

    out.mkdir(parents=True)
    out.chmod(0o700)
    cfg = deepseek.config_from_env()
    started = datetime.now(timezone.utc)
    batches, failures, usage = run(sample, cfg, known, args, observations=True)
    observations, refused = assemble_observations(sample, batches)
    report = {
        "extractor": EXTRACTOR, "requested_model": cfg["model"],
        "prompt_sha256": deepseek.observation_prompt_sha256(),
        "prices": {"read_on": deepseek.PRICES_READ_ON, "usd_per_million_at_peak": deepseek.PRICES,
                   "off_peak": "half of peak", "peak_hours_utc": deepseek.PEAK_HOURS_UTC},
        "seed": None if args.sample_from else args.seed,
        "sample_from": str(args.sample_from) if args.sample_from else None,
        "started_at": started, "population": counts,
        "sample": {"posts": len(sample), "by_group": dict(Counter(group(c) for c in sample)),
                   "known_updates_in_prompt": len(known), "batch_size": args.batch_size},
        "with_observations": {**priced(usage), "failed_batches": failures},
    }
    if args.baseline:
        base_batches, base_failures, base_usage = run(sample, cfg, known, args, observations=False)
        report["baseline"] = {**priced(base_usage), "failed_batches": base_failures}
        save(out / "baseline-batches.json", base_batches)

    posts_with = {s["source_id"] for o in observations for s in o["sources"]}
    by_id = {c["source_id"]: c for c in sample}
    report["observations"] = {
        "count": len(observations), "refused": refused,
        "posts_with_an_observation": len(posts_with),
        "posts_with_by_group": dict(Counter(group(by_id[sid]) for sid in posts_with)),
        "evidence_type": dict(Counter(o["evidence_type"] for o in observations)),
        "actor_role": dict(Counter(o["actor_role"] for o in observations)),
        "outcome": dict(Counter(o["outcome"] for o in observations)),
        "direction": dict(Counter(o["direction"] for o in observations)),
        "with_facts": sum(1 for o in observations if o["facts"]),
        "facts_kept": sum(len(o["facts"]) for o in observations),
        "facts_refused": sum(o["refused_facts"] for o in observations),
        "actor_on_record": sum(1 for o in observations if not o["actor_key"].startswith("unresolved:")),
        "work": dict(Counter(o["work"].lower() for o in observations).most_common(40)),
    }
    per_post = {key: report["with_observations"][key] / len(sample)
                for key in ("usd_all_peak", "usd_all_off_peak")}
    report["estimate_usd"] = {
        name: {"posts": len(items), "all_peak": round(per_post["usd_all_peak"] * len(items), 2),
               "all_off_peak": round(per_post["usd_all_off_peak"] * len(items), 2),
               "observations_expected": round(len(observations) / len(sample) * len(items))}
        for name, items in scopes.items()}
    report["finished_at"] = datetime.now(timezone.utc)
    save(out / "batches.json", batches)
    save(out / "observations.json", observations)
    save(out / "sample.json", [{k: c.get(k) for k in ("source_id", "handle", "url", "published_at", "official")}
                               for c in sample])
    save(out / "report.json", report)
    print(json.dumps({k: report[k] for k in ("sample", "with_observations", "observations", "estimate_usd")}
                     | ({"baseline": report["baseline"]} if args.baseline else {}),
                     ensure_ascii=False, indent=2, default=json_default))
    print(f"report: {out / 'report.json'}", file=sys.stderr)


if __name__ == "__main__":
    main()
