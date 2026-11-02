#!/usr/bin/env python3
"""Other names of the ontology's occupations, for search (Issue #30).

An occupation is found by its O*NET name in English and its translated name in
Chinese. People ask with other words: "software engineer", "程序员", "翻译".
This builds `datasets/ontology/data/occupation_alt_labels.jsonl`, the data file
the next sealed release carries as `Occupation.alt_label` (SKOS altLabel):

- every title in O*NET's sample of reported job titles (CC BY 4.0), as written;
- a Chinese translation of each of them, by DeepSeek (marked as a translation);
- up to three names a Chinese speaker commonly uses for the occupation, proposed
  by DeepSeek, only where the name is not a broader category.

An alternative name is a way to find an occupation, not a claim about what the
occupation is: a reported title can be narrower than the occupation, and the
same Chinese word can name several occupations.

Answers are kept under data/ontology/alt-labels/ (ignored), one file per batch,
so a stopped run resumes and the file can be rebuilt without calling again.

  feyn secret run -- python3 scripts/build-occupation-alt-labels.py
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from data_pipeline import deepseek  # noqa: E402

ONET_ZIP = ROOT / "data/reference/work-taxonomy/2026-09-12/raw/onet_31_0_csv.zip"
REPORTED = "db_31_0_csv/sample_of_reported_titles.csv"
CACHE = ROOT / "data/ontology/alt-labels"
OUTPUT = ROOT / "datasets/ontology/data/occupation_alt_labels.jsonl"
BATCH = 8
PROMPT_VERSION = "alt-labels-1"

SYSTEM = """You give Chinese names for occupations of the US O*NET taxonomy, so that a person searching in Chinese finds them.

For each occupation you get its id, its English name, its existing Chinese name, and the job titles workers in it reported.
Return JSON: {"occupations": [{"id": "...", "translations": {"<reported title exactly as given>": "<Simplified Chinese>"}, "common_names": ["..."]}]}

translations: one natural Simplified Chinese job title for every reported title, as a Chinese job ad or business card would write it. Keep well-known abbreviations only when Chinese uses them too (CEO, CFO, HR). No explanations, no parentheses unless the title needs them.
common_names: at most 3 names a Chinese speaker commonly uses for this occupation in everyday speech or job sites (for example 程序员 for software developers, 客服 for customer service representatives, 翻译 for interpreters and translators). Give none when the existing Chinese name is already what people say. Never give a broader category that also covers other occupations (not 经理 for a specific manager, not 工人 for a specific worker), never the existing Chinese name again, never a word not used for people in this job."""


def occupations(release: Path) -> dict[str, dict]:
    """Occupation concepts of a sealed release, by O*NET code."""
    found = {}
    for line in (release / "concepts.jsonl").read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row["kind"] == "occupation":
            found[row["id"].rsplit(":", 1)[1]] = row
    return found


def reported_titles(path: Path) -> dict[str, list[str]]:
    """O*NET code -> reported titles in source order, without repeats."""
    with zipfile.ZipFile(path) as archive:
        text = archive.read(REPORTED).decode("utf-8")
    titles: dict[str, list[str]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        title = re.sub(r"\s+", " ", row["Reported Job Title"]).strip()
        listed = titles.setdefault(row["O*NET-SOC Code"], [])
        if title and title not in listed:
            listed.append(title)
    return titles


def batch_path(number: int) -> Path:
    return CACHE / PROMPT_VERSION / f"batch-{number:04}.json"


def ask(number: int, batch: list[dict], cfg: dict) -> dict:
    """One call for one batch; the answer is kept and reused when it is there."""
    path = batch_path(number)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    usage: list = []
    message = json.dumps({"occupations": batch}, ensure_ascii=False)
    last = None
    for _ in range(3):
        try:
            answer = deepseek.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": message}],
                                   cfg, timeout=180, usage=usage)
            break
        except deepseek.DeepSeekError as error:
            last = error
    else:
        raise SystemExit(f"batch {number} failed: {last}")
    record = {"prompt_version": PROMPT_VERSION, "input": batch, "answer": answer, "usage": usage}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return record


def clean_zh(text) -> str | None:
    if not isinstance(text, str):
        return None
    text = re.sub(r"\s+", " ", text).strip()
    # A Chinese name has Chinese in it; an answer that only echoes English is no translation.
    return text if text and re.search(r"[一-鿿]", text) and len(text) <= 40 else None


def rows_for(concept: dict, titles: list[str], answer: dict | None) -> list[dict]:
    """The sealed rows of one occupation, English first, in a stable order."""
    rows, seen = [], {("en", concept["label_en"].casefold()), ("zh-CN", concept["label_zh_cn"])}

    def add(label, language, basis, source_label=None):
        key = (language, label.casefold() if language == "en" else label)
        if key in seen:
            return
        seen.add(key)
        row = {"concept_id": concept["id"], "label": label, "language": language, "basis": basis}
        if source_label:
            row["source_label"] = source_label
        rows.append(row)

    for title in titles:
        add(title, "en", "onet_reported_title")
    if answer:
        translations = answer.get("translations") if isinstance(answer.get("translations"), dict) else {}
        for title in titles:
            label = clean_zh(translations.get(title))
            if label:
                add(label, "zh-CN", "reported_title_translation", title)
        names = answer.get("common_names") if isinstance(answer.get("common_names"), list) else []
        for name in names[:3]:
            label = clean_zh(name)
            if label:
                add(label, "zh-CN", "common_name")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", type=Path, help="sealed release whose occupations are named (default: newest)")
    parser.add_argument("--onet", type=Path, default=ONET_ZIP)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--limit", type=int, help="only the first N batches (a trial)")
    args = parser.parse_args()

    releases = ROOT / "datasets/ontology/releases"
    release = args.release or max((p for p in releases.iterdir() if re.fullmatch(r"v\d+\.\d+\.\d+", p.name)),
                                  key=lambda p: tuple(int(x) for x in p.name[1:].split(".")))
    concepts = occupations(release)
    titles = reported_titles(args.onet)
    codes = sorted(concepts)
    batches = [[{"id": concepts[c]["id"], "name_en": concepts[c]["label_en"], "name_zh": concepts[c]["label_zh_cn"],
                 "reported_titles": titles.get(c, [])} for c in codes[i:i + BATCH]]
               for i in range(0, len(codes), BATCH)]
    if args.limit:
        batches = batches[:args.limit]

    if any(not batch_path(n).exists() for n in range(1, len(batches) + 1)):
        deepseek.load_env(ROOT)
        cfg = deepseek.config_from_env()
    else:
        cfg = None
    with ThreadPoolExecutor(args.workers) as pool:
        records = list(pool.map(lambda pair: ask(pair[0], pair[1], cfg), enumerate(batches, 1)))

    answers = {}
    for record in records:
        listed = record["answer"].get("occupations") if isinstance(record["answer"], dict) else None
        for item in listed if isinstance(listed, list) else []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                answers[item["id"]] = item
    rows = []
    for batch in batches:
        for item in batch:
            code = item["id"].rsplit(":", 1)[1]
            rows.extend(rows_for(concepts[code], titles.get(code, []), answers.get(item["id"])))

    missing = [item["id"] for batch in batches for item in batch if item["id"] not in answers]
    usage = [call for record in records for call in record.get("usage", [])]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    by_basis: dict[str, int] = {}
    for row in rows:
        by_basis[row["basis"]] = by_basis.get(row["basis"], 0) + 1
    print(json.dumps({"release": release.name, "occupations": sum(len(b) for b in batches), "rows": len(rows),
                      "by_basis": by_basis, "unanswered": missing, "usd": round(deepseek.billed_usd(usage), 4),
                      "output": str(args.output)}, ensure_ascii=False, indent=1))
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
