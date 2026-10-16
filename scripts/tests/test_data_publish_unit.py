"""Offline unit tests for the published snapshot: type flattening and the manifest.

Dependency-free on purpose (no psycopg, no network): this file runs under
`pnpm data:test:unit` with the system python. `build()` needs a connection, so it
is driven by a fake that dispatches canned rows on the text of each query and
records the parameters; the fake implements only what `_rows()` uses -
`conn.cursor()` as a context manager with `.execute` and `.fetchall`.

`write()` is deliberately not covered here: it writes into
`datasets/published/latest`, which a unit test must not touch.
"""
import json
import sys
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_pipeline import publish  # noqa: E402
from data_pipeline.pipeline import digest  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = json.loads(
    (ROOT / "datasets/ontology/schema/schema.json").read_text(encoding="utf-8"))
METHOD_VERSION = publish.METHOD_VERSION

# Everything in the snapshot except the manifest is the hashed payload. Derived
# from the snapshot rather than restated, so a new section cannot slip out of
# the hash and the counts without failing a test.
REQUIRED_MANIFEST_FIELDS = {
    "snapshot_version", "generated_at", "ontology_version", "schema_version",
    "method_version", "counts", "content_sha256", "caveats"}


def payload_of(snapshot):
    return {key: value for key, value in snapshot.items() if key != "manifest"}


class PlainTests(unittest.TestCase):
    def test_aware_datetime_becomes_an_iso_string(self):
        value = datetime(2026, 9, 22, 12, 30, 5, tzinfo=timezone.utc)
        self.assertEqual(publish._plain(value), "2026-09-22T12:30:05+00:00")
        self.assertIsInstance(publish._plain(value), str)

    def test_naive_datetime_becomes_an_iso_string_without_an_offset(self):
        value = datetime(2026, 9, 22, 12, 30, 5)
        self.assertEqual(publish._plain(value), "2026-09-22T12:30:05")

    def test_microseconds_survive(self):
        value = datetime(2026, 9, 22, 12, 30, 5, 123456, tzinfo=timezone.utc)
        self.assertEqual(publish._plain(value), "2026-09-22T12:30:05.123456+00:00")

    def test_decimal_becomes_a_float(self):
        result = publish._plain(Decimal("2.5"))
        self.assertIsInstance(result, float)
        self.assertEqual(result, 2.5)
        self.assertNotIsInstance(result, Decimal)

    def test_integral_decimal_still_becomes_a_float(self):
        result = publish._plain(Decimal("4"))
        self.assertIsInstance(result, float)
        self.assertEqual(result, 4.0)

    def test_none_stays_none(self):
        self.assertIsNone(publish._plain(None))

    def test_int_str_and_bool_pass_through_unchanged(self):
        for value in (0, 7, -3, "", "T1", True, False, 1.5):
            with self.subTest(value=value):
                self.assertIs(publish._plain(value), value)

    def test_int_is_not_widened_to_float(self):
        result = publish._plain(3)
        self.assertIsInstance(result, int)
        self.assertNotIsInstance(result, float)

    def test_nested_structures_pass_through_by_identity(self):
        # The JSON columns (impact.gates, metrics) arrive already decoded.
        nested = [{"gate_id": "g1", "status": "candidate"}]
        self.assertIs(publish._plain(nested), nested)
        mapping = {"a": 1}
        self.assertIs(publish._plain(mapping), mapping)

    def test_a_plain_date_is_not_converted(self):
        # date is not datetime, so it is left alone; the queries select
        # timestamps, and a bare date would not be JSON-serialisable.
        value = date(2026, 9, 22)
        self.assertIs(publish._plain(value), value)

    def test_plain_is_idempotent(self):
        once = publish._plain(Decimal("2.5"))
        self.assertEqual(publish._plain(once), once)
        stamp = publish._plain(datetime(2026, 9, 22, tzinfo=timezone.utc))
        self.assertEqual(publish._plain(stamp), stamp)


class CleanTests(unittest.TestCase):
    def test_maps_plain_over_every_value_of_every_row(self):
        rows = [
            {"id": "a", "stage": Decimal("3.5"), "as_of":
                datetime(2026, 9, 22, tzinfo=timezone.utc), "n": 2, "note": None},
            {"id": "b", "stage": None, "as_of": None, "n": 0, "note": "x"},
        ]
        self.assertEqual(publish._clean(rows), [
            {"id": "a", "stage": 3.5, "as_of": "2026-09-22T00:00:00+00:00",
             "n": 2, "note": None},
            {"id": "b", "stage": None, "as_of": None, "n": 0, "note": "x"},
        ])

    def test_empty_input_gives_an_empty_list(self):
        self.assertEqual(publish._clean([]), [])

    def test_rows_with_no_columns_survive(self):
        self.assertEqual(publish._clean([{}]), [{}])

    def test_keys_and_order_are_preserved(self):
        rows = [{"b": 1, "a": Decimal("2")}]
        self.assertEqual(list(publish._clean(rows)[0]), ["b", "a"])

    def test_input_rows_are_not_mutated(self):
        original = {"stage": Decimal("3.5")}
        rows = [original]
        cleaned = publish._clean(rows)
        self.assertIsInstance(original["stage"], Decimal)
        self.assertIsNot(cleaned[0], original)

    def test_result_is_json_serialisable(self):
        rows = [{"stage": Decimal("3.5"), "as_of": datetime(2026, 9, 22,
                                                            tzinfo=timezone.utc)}]
        self.assertEqual(json.loads(json.dumps(publish._clean(rows))),
                         [{"stage": 3.5, "as_of": "2026-09-22T00:00:00+00:00"}])


# --- build() against a fake connection ----------------------------------------

def squeeze(sql):
    return " ".join(sql.split())


# Checked in order; the first substring that matches names the query. Order
# matters because several queries mention the same tables in subselects.
ROUTES = (
    # Topics read their own tables, and the accounts and catalog tables other
    # queries read too; each is matched on a phrase only it contains.
    ("topics", "FROM topics t"),
    ("topic_options", "FROM topic_options WHERE NOT retired"),
    ("topic_claims", "FROM topic_claims k"),
    ("topic_queries", "FROM topic_queries"),
    ("topic_panel", "SELECT handle, account_key FROM public.source_accounts"),
    ("topic_kinds", "SELECT id, kind, label_en, label_zh_cn FROM public.ontology_concepts"),
    ("topic_parents", "SELECT child_id, parent_id FROM public.ontology_relations"),
    ("topic_evidence", "FROM public.topic_option_evidence w"),
    # The sources export reads the collection tables too, so its queries are
    # matched first, each on a phrase only it contains.
    ("source_accounts", "FROM public.source_accounts a LEFT JOIN public.people"),
    ("source_affiliations", "FROM public.person_affiliations f"),
    ("source_totals", "FROM public.collected_sources GROUP BY account_external_id"),
    ("source_latest", "PARTITION BY s.account_external_id"),
    ("source_followers", "check_kind = 'profile'"),
    # The attention queries read the capture tables and the event-source links;
    # matched first so the events route below cannot swallow the link query.
    ("attention_captures", "JOIN public.collected_captures cc ON cc.source_id = cs.source_id"),
    ("attention_links", "JOIN public.extracted_events e ON e.event_id = s.event_id"),
    ("releases", "public.ontology_releases"),
    # The progress queries share a prefix ("WITH capped AS") and differ only in
    # their innermost CTE, so each is matched on that rather than on its head.
    ("progress_groups", "group_task AS ("),
    ("progress_markets", "market_task AS ("),
    ("progress_occupations", "occupation_task AS ("),
    ("progress_global", "FROM per_task GROUP BY 1"),
    ("group_labels", "kind = 'occupation_group'"),
    ("market_labels", "kind = 'market'"),
    ("occupation_labels", "kind = 'occupation'"),
    ("occupation_group", "kind = 'has_occupation'"),
    # The activity query embeds the same level CTE the progress ones do, so it
    # has to be matched before them on its own join.
    ("activities", "r.kind = 'has_work'"),
    ("markets", "FROM public.market_occupation_edges e"),
    ("tasks", "FROM public.activity_task_edges t"),
    ("evidence", "FROM public.activity_evidence ae"),
    ("confirmations", "LEFT JOIN public.source_accounts sa ON sa.account_key = ve.account_key"),
    ("gates", "FROM public.gates g"),
    ("gate_edges", "FROM public.activity_gate_edges ge"),
    # by_org joins the same two tables as events, so it has to be matched first
    # on its own literal or it disappears into the events route.
    ("models", "FROM public.models m"),
    ("model_checks", "FROM public.event_model_checks"),
    ("event_models", "FROM public.event_models ORDER BY"),
    ("by_org", "'unattributed'"),
    ("events", "FROM public.extracted_events e LEFT JOIN public.org_registry"),
    # Both of these also read extracted_events; neither joins org_registry, so
    # they cannot be swallowed by the events marker above.
    ("generations", "count(DISTINCT e.event_id) AS events"),
    ("shared_posts", "INTERSECT"),
    ("work_total", "count(*) AS n FROM public.ontology_concepts w"),
    ("event_kinds", "coalesce(kind, '(unresolved)')"),
    ("routed", "FROM public.judgment_checkpoints"),
    ("window", "min(occurred_at) AS first"),
    ("in_progress", "FROM public.judgment_runs WHERE status = 'running'"),
    ("runs", "FROM public.judgment_runs ORDER BY started_at"),
)


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.result = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        squeezed = squeeze(sql)
        name = self.conn.route(squeezed)
        self.conn.calls.append((name, params))
        self.conn.sql[name] = squeezed
        self.result = self.conn.data.get(name, [])

    def fetchall(self):
        return list(self.result)


class FakeConn:
    def __init__(self, data):
        self.data = data
        self.calls = []
        self.sql = {}

    def cursor(self):
        return FakeCursor(self)

    def route(self, sql):
        for name, marker in ROUTES:
            if marker in sql:
                return name
        raise AssertionError(f"unrouted query: {sql[:120]}")

    def params_for(self, name):
        found = [params for called, params in self.calls if called == name]
        assert len(found) == 1, f"expected one {name} query, saw {len(found)}"
        return found[0]

    @property
    def called(self):
        return [name for name, _ in self.calls]


def dataset(**overrides):
    """Canned result sets, one per query in build().

    The shapes mirror what the activity layer actually returns: one activity
    that reached L2 on a vendor claim, one nobody has looked at, a task each way
    and one update behind the reading.
    """
    data = {
        "attention_captures": [
            {"source_id": "src:1", "account_handle": "ExampleLab",
             "published_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
             "captured_at": datetime(2026, 9, 8, tzinfo=timezone.utc),
             "metrics": {"views": 1200, "likes": 30}},
            {"source_id": "src:2", "account_handle": "ExampleLab",
             "published_at": datetime(2026, 8, 20, tzinfo=timezone.utc),
             "captured_at": datetime(2026, 8, 27, tzinfo=timezone.utc),
             "metrics": {"views": 400, "likes": 5}},
        ],
        "attention_links": [{"event_id": "evt:1", "source_id": "src:1"}],
        "releases": [{"version": "1.0.0"}],
        "activities": [
            {"activity_id": "oaw:market:audit-evidence", "label_en": "Gather audit evidence",
             "label_zh_cn": "取证", "market_id": "oaw:market:audit", "market_en": "Audit",
             "market_zh_cn": "审计", "level": Decimal("2.0"), "best_tier": "T3",
             "evidence_rows": 3, "gated": False, "tasks": 4, "gates": 0},
            {"activity_id": "oaw:market:bedside-care", "label_en": "Bedside care",
             "label_zh_cn": "床旁照护", "market_id": "oaw:market:nursing", "market_en": "Nursing",
             "market_zh_cn": "护理", "level": None, "best_tier": None,
             "evidence_rows": None, "gated": False, "tasks": 2, "gates": 1},
        ],
        "markets": [
            {"market_id": "oaw:market:audit", "occupation_id": "oaw:occupation:13-2011.00",
             "confidence": Decimal("0.810"), "status": "candidate",
             "occupation_en": "Accountants and Auditors", "occupation_zh_cn": "会计与审计师"},
        ],
        "tasks": [
            {"activity_id": "oaw:market:audit-evidence", "task_id": "oaw:task:1",
             "confidence": Decimal("0.740"), "status": "candidate"},
            {"activity_id": "oaw:market:bedside-care", "task_id": "oaw:task:2",
             "confidence": Decimal("0.690"), "status": "candidate"},
        ],
        "evidence": [
            {"activity_id": "oaw:market:audit-evidence", "event_id": "evt:1",
             "evidence_tier": "T3", "evidence_sign": "positive",
             "observed_level": Decimal("2.0"), "confidence": Decimal("0.800"),
             "rationale": "The vendor describes the model drafting the workpaper.",
             "status": "candidate", "activity_en": "Gather audit evidence",
             "activity_zh_cn": "取证", "title": "Model update", "summary": "Longer form.",
             "kind": "product_launch", "kind_vocabulary": "event_kind-2.0.0",
             "occurred_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
             "org_name": "Example Lab", "primary_org_id": "org:example"},
        ],
        "gates": [
            {"gate_id": "gate:physical-presence", "gate_type": "physical_presence",
             "label_en": "Physical presence", "label_zh_cn": "现场在场",
             "definition_en": "Someone has to be there.", "definition_zh_cn": "必须有人在场。",
             "status": "closed", "state_rationale": "Nothing in the window moved it.",
             "state_as_of": datetime(2026, 9, 20, tzinfo=timezone.utc),
             "source_event_id": None, "candidate_activities": 1, "reviewed_activities": 0},
        ],
        # The edge behind that count. Publishing the count alone let a page say
        # "254 activities" without being able to name one of them.
        "gate_edges": [
            {"gate_id": "gate:physical-presence", "activity_id": "oaw:market:m1-b",
             "confidence": Decimal("0.700"), "status": "candidate"},
        ],
        "events": [
            {"event_id": "evt:1", "title": "Model update", "summary": "Longer form.",
             "kind": "product_launch", "kind_vocabulary": "event_kind-2.0.0",
             "unresolved_reason": None, "subject_key": "example/model",
             "identity_confidence": Decimal("0.900"),
             "occurred_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
             "confidence": Decimal("0.900"), "primary_org_id": "org:example",
             "org_name": "Example Lab", "org_name_zh_cn": "示例实验室",
             "source_urls": ["https://example.invalid/1"]},
        ],
        "models": [
            {"model_id": "model:example:ex-2", "org_id": "org:example", "owner": "Example Lab",
             "owner_zh_cn": "示例实验室", "level": "release",
             "parent_model_id": "model:example:ex", "name": "Ex 2", "version": "2",
             "variant": None, "released_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
             "status": "confirmed", "events": 1},
        ],
        "model_checks": [{"event_id": "evt:1"}],
        "event_models": [{"event_id": "evt:1", "model_id": "model:example:ex-2", "role": "subject"}],
        "generations": [
            {"vocabulary": "event_kind-2.0.0", "events": 1, "source_posts": 1},
        ],
        "shared_posts": [{"n": 0}],
        "work_total": [{"n": 6}],
        "event_kinds": [
            {"kind_vocabulary": "event_kind-2.0.0", "kind": "product_launch", "n": 1},
        ],
        # 325 of 581 updates bore on nothing. The fixture keeps that shape: the
        # gap between routed and bearing is the most important pair on the page.
        "routed": [{"events": 4, "events_with_activity": 1, "readings": 1}],
        "window": [{"first": datetime(2026, 8, 24, tzinfo=timezone.utc),
                    "last": datetime(2026, 9, 20, tzinfo=timezone.utc), "events": 1}],
        "by_org": [{"org": "Example Lab", "events": 1}],
        "runs": [
            {"run_id": "run:1", "judge": "typesafe", "model": "jev", "task": "serves_market",
             "method_version": "market-occupation-2", "status": "completed",
             "item_count": 265, "decided_count": 265,
             "started_at": datetime(2026, 9, 21, tzinfo=timezone.utc),
             "finished_at": datetime(2026, 9, 21, 1, tzinfo=timezone.utc)},
        ],
        "in_progress": [],
        "progress_global": [
            {"stage": 2, "coverage": "assessed", "work_items": 1},
            {"stage": None, "coverage": "unknown", "work_items": 2},
            {"stage": None, "coverage": "untouched", "work_items": 3},
        ],
        "progress_occupations": [
            {"occupation_id": "oaw:occupation:13-2011.00", "stage": 2,
             "coverage": "assessed", "work_items": 1},
            {"occupation_id": "oaw:occupation:13-2011.00", "stage": None,
             "coverage": "untouched", "work_items": 2},
        ],
        "progress_groups": [
            {"group_id": "oaw:occupation-group:13", "stage": 2,
             "coverage": "assessed", "work_items": 1},
        ],
        "progress_markets": [
            {"market_id": "oaw:market:audit", "stage": 2, "coverage": "assessed",
             "work_items": 1},
            {"market_id": "oaw:market:nursing", "stage": None, "coverage": "untouched",
             "work_items": 3},
        ],
        "group_labels": [
            {"id": "oaw:occupation-group:13", "label_en": "Business and Financial",
             "label_zh_cn": "商业与金融"},
        ],
        "market_labels": [
            {"id": "oaw:market:audit", "label_en": "Audit", "label_zh_cn": "审计"},
            {"id": "oaw:market:nursing", "label_en": "Nursing", "label_zh_cn": "护理"},
        ],
        "occupation_labels": [
            {"id": "oaw:occupation:13-2011.00", "label_en": "Accountants and Auditors",
             "label_zh_cn": "会计与审计师"},
        ],
        "occupation_group": [
            {"parent_id": "oaw:occupation-group:13",
             "child_id": "oaw:occupation:13-2011.00"},
        ],
    }
    data.update(overrides)
    return data


def build(data=None, ontology_version="1.0.0"):
    conn = FakeConn(data if data is not None else dataset())
    return conn, publish.build(conn, ontology_version)


class BuildManifestTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.snapshot = build()
        self.manifest = self.snapshot["manifest"]

    def test_manifest_fields(self):
        self.assertLessEqual(REQUIRED_MANIFEST_FIELDS, set(self.manifest))
        self.assertEqual(self.manifest["snapshot_version"], publish.SNAPSHOT_VERSION)
        self.assertEqual(self.manifest["ontology_version"], "1.0.0")
        self.assertEqual(self.manifest["schema_version"], SCHEMA["version"])
        self.assertEqual(self.manifest["method_version"], METHOD_VERSION)

    def test_every_reading_is_published_not_only_one_runs_worth(self):
        """The evidence file was empty for a fortnight because of this filter.

        It selected capability_evidence scoped to the newest completed run with
        task='demonstrates' - and the event routing pass registers itself under
        that same task name, so the filter matched nothing and published an
        empty list while 710 readings sat in the database. Two layers sharing
        one task name was the direct cause; the scoping is gone.
        """
        self.assertNotIn("evidence_run", self.manifest)
        self.assertEqual(self.conn.params_for("evidence"), ("1.0.0",))
        self.assertEqual(len(self.snapshot["chain"]["evidence"]), 1)

    def test_generated_at_is_an_iso_utc_string(self):
        stamp = self.manifest["generated_at"]
        self.assertIsInstance(stamp, str)
        parsed = datetime.fromisoformat(stamp)
        self.assertEqual(parsed.utcoffset(), timezone.utc.utcoffset(None))

    def test_content_sha256_covers_exactly_the_payload(self):
        self.assertEqual(self.manifest["content_sha256"], digest(payload_of(self.snapshot)))
        self.assertEqual(len(self.manifest["content_sha256"]), 64)
        int(self.manifest["content_sha256"], 16)  # hex

    def test_content_sha256_excludes_the_manifest_itself(self):
        # The hash must not cover generated_at, or two identical exports would
        # never compare equal.
        self.assertNotEqual(self.manifest["content_sha256"], digest(dict(self.snapshot)))

    def test_content_sha256_changes_when_the_data_changes(self):
        data = dataset()
        data["activities"][0]["level"] = Decimal("4.0")
        _, other = build(data)
        self.assertNotEqual(self.manifest["content_sha256"],
                            other["manifest"]["content_sha256"])

    def test_content_sha256_is_stable_for_identical_data(self):
        _, again = build()
        self.assertEqual(self.manifest["content_sha256"],
                         again["manifest"]["content_sha256"])

    def test_counts_match_the_actual_list_lengths(self):
        counts = self.manifest["counts"]
        payload = payload_of(self.snapshot)
        # chain is four lists in one file, so the manifest counts them
        # individually: counting it as "1" would publish a manifest that cannot
        # be checked against the file it describes.
        expected = set()
        for key, value in payload.items():
            if key == "chain":
                expected.update(f"chain.{inner}" for inner in value)
            else:
                expected.add(key)
        self.assertEqual(sorted(counts), sorted(expected))
        for key, value in payload.items():
            with self.subTest(key=key):
                if key == "chain":
                    for inner, rows in value.items():
                        self.assertEqual(counts[f"chain.{inner}"], len(rows))
                elif isinstance(value, list):
                    self.assertEqual(counts[key], len(value))
                else:
                    self.assertEqual(counts[key], 1)
        self.assertEqual(
            {k: counts[k] for k in ("chain.activities", "markets", "tasks",
                                    "chain.gates", "chain.gate_edges",
                                    "chain.evidence", "chain.events", "events",
                                    "coverage", "progress")},
            {"chain.activities": 2, "markets": 1, "tasks": 2, "chain.gates": 1,
             "chain.gate_edges": 1, "chain.evidence": 1, "chain.events": 1,
             "events": 1, "coverage": 1, "progress": 1})

    def test_counts_follow_the_rows_actually_returned(self):
        data = dataset(events=[], gates=[])
        _, snapshot = build(data)
        self.assertEqual(snapshot["manifest"]["counts"]["events"], 0)
        self.assertEqual(snapshot["manifest"]["counts"]["chain.gates"], 0)
        self.assertEqual(snapshot["events"], [])


class CaveatTests(unittest.TestCase):
    def setUp(self):
        _, self.snapshot = build()
        self.caveats = self.snapshot["manifest"]["caveats"]

    def test_caveats_are_bilingual_and_aligned(self):
        self.assertEqual(sorted(self.caveats), ["en", "zh-CN"])
        self.assertEqual(len(self.caveats["en"]), len(self.caveats["zh-CN"]))
        # Counted by content, not by a magic number: a caveat added later should
        # not fail this test, but a caveat present in one language only must.
        self.assertGreaterEqual(len(self.caveats["en"]), 3)
        for language, lines in self.caveats.items():
            for line in lines:
                with self.subTest(language=language):
                    self.assertIsInstance(line, str)
                    self.assertTrue(line.strip())

    def test_the_unreviewed_caveat_is_present_in_both_languages(self):
        self.assertIn("machine-proposed and", self.caveats["en"][0])
        self.assertIn("unreviewed", self.caveats["en"][0])
        self.assertIn("未经复核", self.caveats["zh-CN"][0])

    def one(self, language, needle):
        """The caveat containing `needle`, found by content rather than position.

        These used to be indexed. Adding a caveat at the front then silently
        moved every assertion onto the wrong sentence, which is a worse failure
        than not testing at all: the test still passes on the wrong text.
        """
        found = [c for c in self.caveats[language] if needle in c]
        self.assertEqual(len(found), 1,
                         f"expected exactly one {language} caveat containing {needle!r}")
        return found[0]

    def test_the_tier_cap_caveat_names_every_rung_it_binds(self):
        """A reader seeing nothing above L2 has to be able to find out why.

        The cap is the answer - a vendor's own claim supports L2 and no more -
        and it is useless unless the caveat says which tier buys which rung.
        """
        english = self.one("en", "Evidence caps what that level may reach")
        for rung in ("L5", "L4", "L2", "L1", "L0"):
            self.assertIn(rung, english)
        self.assertIn("independent measurement", english)
        chinese = self.one("zh-CN", "证据决定这个层级最高能到哪")
        self.assertIn("厂商自证 L2", chinese)

    def test_the_three_states_are_explained_in_both_languages(self):
        """Progress is the number on the page; its blanks need saying out loud."""
        english = self.one("en", "Three states are counted separately")
        for phrase in ("assessed", "unknown", "untouched", "none of them is zero"):
            self.assertIn(phrase, english)
        chinese = self.one("zh-CN", "已判定、未知、未触及分开计数")
        for phrase in ("已判定", "未知", "未触及", "没有一种等于 0"):
            self.assertIn(phrase, chinese)

    def test_the_collection_window_is_declared_as_a_limit_on_the_reading(self):
        """An empty market means nothing was collected, never that AI has no bearing.

        The evidence is three weeks of one collection run weighted towards a few
        publishers; a share computed over it is a reading of that window and has
        to say so on the page rather than only in the journal.
        """
        self.assertIn("never that AI has no bearing",
                      self.one("en", "not evenly spread"))
        self.assertIn("绝不说明 AI 与它无关", self.one("zh-CN", "分布很不均匀"))


class ConfirmationTests(unittest.TestCase):
    """A post that confirmed a vendor's claim is published on the reading it confirmed.

    These readings count toward the activity's level, and until 2026-10-16 none was
    published: one work page stood at L3 with only L2 readings listed under it.
    """

    def setUp(self):
        self.conn, self.snapshot = build(dataset(confirmations=[
            {"event_id": "evt:1", "activity_id": "oaw:market:audit-evidence",
             "source_id": "2102916558712705427", "account_key": "x:tester", "handle": "Tester",
             "post_nature": "hands_on_test", "evidence_tier": "T1", "observed_level": 4,
             "level": Decimal("3")},
        ]))

    def test_the_confirmation_sits_on_the_reading_it_confirms_with_its_post(self):
        [reading] = self.snapshot["chain"]["evidence"]
        self.assertEqual(reading["confirmations"], [{
            "source_id": "2102916558712705427", "account_key": "x:tester", "handle": "Tester",
            "url": "https://x.com/Tester/status/2102916558712705427",
            # Read from the post id itself, which carries its time.
            "posted_at": "2026-09-24T00:22:32.554000+00:00",
            "post_nature": "hands_on_test", "evidence_tier": "T1", "observed_level": 4, "level": 3.0,
        }])

    def test_the_query_counts_what_the_level_counts(self):
        sql = self.conn.sql["confirmations"]
        self.assertIn("ve.evidence_tier IS NOT NULL AND ve.observed_level IS NOT NULL", sql)
        self.assertIn("ve.status IN ('candidate', 'reviewed')", sql)
        self.assertEqual(self.conn.params_for("confirmations"), ("1.0.0",))

    def test_a_reading_nobody_confirmed_has_no_field_at_all(self):
        """So its document, and the release diff, stay as they were."""
        _, snapshot = build()
        self.assertNotIn("confirmations", snapshot["chain"]["evidence"][0])


class BuildPayloadTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.snapshot = build()

    def test_database_types_are_flattened_in_the_payload(self):
        activity = self.snapshot["chain"]["activities"][0]
        self.assertIsInstance(activity["level"], float)
        self.assertEqual(activity["level"], 2.0)
        # An activity nobody has looked at keeps a null level, never a zero:
        # "no update mentioned it" and "the evidence says AI takes no part" are
        # different findings and must not render as the same square.
        self.assertIsNone(self.snapshot["chain"]["activities"][1]["level"])
        self.assertEqual(self.snapshot["tasks"][0]["confidence"], 0.74)
        # The date belongs to the update, so it is stored once on the chain's
        # event and joined onto the reading at render time rather than repeated
        # on all 710 of them.
        self.assertEqual(self.snapshot["chain"]["events"][0]["occurred_at"],
                         "2026-09-01T00:00:00+00:00")
        self.assertNotIn("occurred_at", self.snapshot["chain"]["evidence"][0])

    def test_the_whole_snapshot_is_json_serialisable(self):
        text = json.dumps(self.snapshot, ensure_ascii=False)
        self.assertEqual(json.loads(text)["manifest"]["content_sha256"],
                         self.snapshot["manifest"]["content_sha256"])

    def test_coverage_reports_the_gap_not_only_the_findings(self):
        coverage = self.snapshot["coverage"]
        self.assertEqual(coverage["work_items_total"], 6)
        self.assertEqual(coverage["activities_total"], 2)
        self.assertEqual(coverage["activities_with_evidence"], 1)
        # The pair that matters most: updates read, against updates that turned
        # out to bear on any activity at all. In the real snapshot that is 581
        # against 256, and publishing only the first would overstate the reach
        # of the whole corpus by more than double.
        self.assertEqual(coverage["events_routed"], 4)
        self.assertEqual(coverage["events_bearing_on_activity"], 1)
        self.assertLess(coverage["events_bearing_on_activity"], coverage["events_routed"])

    def test_the_collection_skew_is_published_not_summarised(self):
        """A reader has to see who the updates came from before reading them."""
        by_org = self.snapshot["coverage"]["events_by_organisation"]
        self.assertEqual(by_org, [{"org": "Example Lab", "events": 1}])
        window = self.snapshot["coverage"]["collection_window"]
        self.assertEqual(window["first"], "2026-08-24T00:00:00+00:00")
        self.assertEqual(window["last"], "2026-09-20T00:00:00+00:00")

    def test_coverage_carries_run_provenance_with_flattened_timestamps(self):
        runs = self.snapshot["coverage"]["judgment_runs"]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["started_at"], "2026-09-21T00:00:00+00:00")
        self.assertEqual(runs[0]["run_id"], "run:1")
        self.assertEqual(self.snapshot["coverage"]["event_kinds"][0]["n"], 1)

    def test_candidate_and_reviewed_counts_stay_separate(self):
        """Nothing has been reviewed. The counts keep saying so separately."""
        gate = self.snapshot["chain"]["gates"][0]
        self.assertEqual(gate["candidate_activities"], 1)
        self.assertEqual(gate["reviewed_activities"], 0)
        self.assertEqual(self.snapshot["tasks"][0]["status"], "candidate")
        self.assertEqual(self.snapshot["chain"]["evidence"][0]["status"], "candidate")

    def test_a_sweep_in_flight_is_declared(self):
        # "19,397 unjudged" is true and misleading while a run is halfway
        # through, so an in-flight run has to reach the page.
        self.assertEqual(self.snapshot["coverage"]["runs_in_progress"], [])
        data = dataset(in_progress=[
            {"run_id": "run-2", "judge": "typesafe", "task": "requires",
             "item_count": 500,
             "started_at": datetime(2026, 9, 22, tzinfo=timezone.utc)}])
        _, snapshot = build(data)
        running = snapshot["coverage"]["runs_in_progress"]
        self.assertEqual(len(running), 1)
        self.assertEqual(running[0]["run_id"], "run-2")
        self.assertEqual(running[0]["started_at"], "2026-09-22T00:00:00+00:00")


class EventModelTests(unittest.TestCase):
    def test_an_update_carries_the_models_it_names(self):
        _, snapshot = build()
        self.assertEqual(snapshot["events"][0]["models"],
                         [{"model_id": "model:example:ex-2", "role": "subject", "status": "confirmed"}])
        self.assertEqual(snapshot["models"][0]["released_at"], "2026-09-01T00:00:00+00:00")

    def test_read_and_naming_none_is_empty_and_unread_is_null(self):
        _, snapshot = build(dataset(event_models=[]))
        self.assertEqual(snapshot["events"][0]["models"], [])
        _, snapshot = build(dataset(event_models=[], model_checks=[]))
        self.assertIsNone(snapshot["events"][0]["models"])


class OntologyVersionTests(unittest.TestCase):
    def test_an_explicit_version_skips_the_release_lookup(self):
        conn, snapshot = build()
        self.assertNotIn("releases", conn.called)
        self.assertEqual(snapshot["manifest"]["ontology_version"], "1.0.0")

    def test_the_version_parameterises_the_graph_queries(self):
        conn, _ = build()
        self.assertEqual(conn.params_for("work_total"), ("1.0.0",))
        for name in ("activities", "markets", "tasks", "evidence"):
            with self.subTest(query=name):
                self.assertEqual(conn.params_for(name), ("1.0.0",))

    def test_the_latest_release_is_used_when_none_is_given(self):
        conn = FakeConn(dataset(releases=[{"version": "2.0.0"}]))
        snapshot = publish.build(conn)
        self.assertEqual(conn.called[0], "releases")
        self.assertEqual(snapshot["manifest"]["ontology_version"], "2.0.0")
        self.assertEqual(conn.params_for("tasks"), ("2.0.0",))

    def test_no_release_is_refused_rather_than_guessed(self):
        conn = FakeConn(dataset(releases=[]))
        with self.assertRaises(ValueError) as caught:
            publish.build(conn)
        self.assertIn("No ontology release imported", str(caught.exception))

    def test_every_query_runs_exactly_once(self):
        conn, _ = build()
        self.assertEqual(len(conn.called), len(set(conn.called)))
        for name in ("activities", "markets", "tasks", "gates", "evidence",
                     "events", "generations", "work_total", "event_kinds",
                     "routed", "window", "by_org", "runs", "in_progress"):
            with self.subTest(query=name):
                self.assertIn(name, conn.called)



class EventGenerationTests(unittest.TestCase):
    """One collection window, one reading of it.

    The table held two: 755 events extracted under the free-form vocabulary and
    581 under event_kind-2.0.0, over the same three weeks and largely the same
    posts. Publishing one while storing both made every event count ambiguous -
    1,336 rows behind a page that said 581 - so migration 022 dropped the
    superseded generation. The filter stays: it is what keeps a future
    re-extraction from publishing two answers at once.
    """

    def test_only_the_current_vocabulary_is_published(self):
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        # Every version of the current lineage, and only a company's own updates.
        self.assertIn(publish.EVENT_KIND_VOCABULARIES, conn.params_for("events"))
        self.assertIn("WHERE e.kind_vocabulary = ANY(%s) AND e.primary_org_id IS NOT NULL", conn.sql["events"])

    def test_a_second_generation_would_be_declared_not_hidden(self):
        """If one ever appears again, the page says so rather than quietly
        publishing the smaller half."""
        data = dataset(generations=[
            {"vocabulary": "event_kind-2.0.0", "events": 1, "source_posts": 1},
            {"vocabulary": "legacy-freeform", "events": 9, "source_posts": 9},
        ])
        _, snapshot = build(data)
        by_vocabulary = {g["vocabulary"]: g
                         for g in snapshot["coverage"]["event_generations"]}
        self.assertTrue(by_vocabulary["event_kind-2.0.0"]["published"])
        self.assertFalse(by_vocabulary["legacy-freeform"]["published"])

    def test_events_are_counted_not_joined(self):
        """A LEFT JOIN on source posts makes count(*) count join rows."""
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        self.assertIn("count(DISTINCT e.event_id) AS events", conn.sql["generations"])
        self.assertNotIn("count(*) AS events", conn.sql["generations"])


class WorkProgressTests(unittest.TestCase):
    """Progress is counted in distinct work items, in three states, over L0-L5."""

    def test_the_global_buckets_are_published_with_their_total(self):
        progress = publish.build(FakeConn(dataset()), "1.0.0")["progress"]
        self.assertEqual(progress["work_items_total"], 1 + 2 + 3)
        self.assertEqual(progress["assessed"], 1)
        self.assertEqual(progress["unknown"], 2)
        self.assertEqual(progress["untouched"], 3)

    def test_unknown_and_untouched_are_never_merged(self):
        """The distinction is the method: neither of them is zero.

        A task no activity covers has not been looked at. A task covered by an
        activity with no evidence has been looked at and did not resolve. One
        bucket for both is how "nobody has measured this" comes to read as
        "AI cannot do this".
        """
        progress = publish.build(FakeConn(dataset()), "1.0.0")["progress"]
        blanks = {row["coverage"]: row["work_items"]
                  for row in progress["global"] if row["stage"] is None}
        self.assertEqual(blanks, {"untouched": 3, "unknown": 2})
        self.assertEqual(progress["states"], ["assessed", "unknown", "untouched"])

    def test_level_five_is_declared_even_with_no_rows(self):
        """An empty L5 is the headline of the chart, not a missing bucket."""
        progress = publish.build(FakeConn(dataset()), "1.0.0")["progress"]
        self.assertEqual(progress["stages"], [0, 1, 2, 3, 4, 5])
        self.assertNotIn(5, [row["stage"] for row in progress["global"]])

    def test_the_tier_caps_travel_with_the_numbers(self):
        # Nothing sits above L2 while the evidence is vendor self-report. The
        # reader can only see why if the ceiling is published alongside.
        caps = publish.build(FakeConn(dataset()), "1.0.0")["progress"]["tier_caps"]
        self.assertEqual(caps, {"T1": 5, "T2": 4, "T3": 2, "T4": 1})

    def test_an_occupation_carries_its_own_squares(self):
        progress = publish.build(FakeConn(dataset()), "1.0.0")["progress"]
        entry = progress["occupations"]["oaw:occupation:13-2011.00"]
        self.assertEqual(entry["tasks"], 3)
        self.assertEqual(entry["by_stage"], {"2": 1, "untouched": 2})
        # The label rides on the row. It used to be read off the capability
        # impact rows, so an occupation no capability reached had no name.
        self.assertEqual(entry["label_en"], "Accountants and Auditors")
        self.assertEqual(entry["label_zh_cn"], "会计与审计师")

    def test_a_market_carries_its_own_squares_and_its_label(self):
        # Markets are kinds of work rather than industries, which is why an
        # update lands on one at all - and why one can carry a share.
        progress = publish.build(FakeConn(dataset()), "1.0.0")["progress"]
        entry = progress["markets"]["oaw:market:audit"]
        self.assertEqual(entry["tasks"], 1)
        self.assertEqual(entry["by_stage"], {"2": 1})
        self.assertEqual(entry["label_zh_cn"], "审计")

    def test_progress_no_longer_asks_the_capability_layer_anything(self):
        """Forty-one of the forty-six capabilities matched nearly everything, so
        the layer answered every question with the same answer. Evidence lands on
        the 614 market activities now, and the progress query must not reach back.
        """
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        for name in ("progress_global", "progress_occupations",
                     "progress_groups", "progress_markets"):
            self.assertNotIn("capability_states", conn.sql[name])
            self.assertNotIn("concept_capability_edges", conn.sql[name])

    def test_a_fractional_reading_is_published_as_a_category(self):
        """The judge's score is kept for provenance; the site gets the level."""
        evidence = dict(dataset()["evidence"][0], evidence_tier="T2",
                        observed_level=Decimal("3.82"))
        _, snapshot = build(dataset(evidence=[evidence]))
        row = snapshot["chain"]["evidence"][0]
        self.assertEqual(row["observed_level"], 3)
        self.assertEqual(row["level"], 3)
        self.assertEqual(row["observed_score"], 3.82)

    def test_the_cap_applies_after_rounding(self):
        evidence = dict(dataset()["evidence"][0], evidence_tier="T3",
                        observed_level=Decimal("3.82"))
        _, snapshot = build(dataset(evidence=[evidence]))
        row = snapshot["chain"]["evidence"][0]
        self.assertEqual((row["observed_level"], row["level"]), (3, 2))

    def test_a_reading_below_one_is_published_but_not_counted(self):
        evidence = dict(dataset()["evidence"][0], observed_level=Decimal("0.9"))
        _, snapshot = build(dataset(evidence=[evidence]))
        row = snapshot["chain"]["evidence"][0]
        self.assertEqual(row["observed_score"], 0.9)
        self.assertIsNone(row["level"])

    def test_a_barrier_caps_rather_than_zeroes(self):
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        sql = conn.sql["progress_global"]
        self.assertNotIn("THEN 0.0", sql)
        self.assertIn("LEAST(b.level, 3)", sql)
        self.assertIn("ae.observed_level >= 1.0", sql)

    def test_events_carry_attention_relative_to_their_account(self):
        _, snapshot = build()
        event = next(e for e in snapshot["events"] if e["event_id"] == "evt:1")
        self.assertEqual(event["attention"]["views"], 1200)
        self.assertEqual(event["attention"]["engagement"], 30)
        self.assertEqual(event["attention"]["ratio"], 1.714)   # 30 / median(30, 5)
        self.assertEqual(event["attention"]["snapshot_age_hours"], 168)
        self.assertFalse(event["attention"]["provisional"])

    def test_attention_never_enters_a_level_query(self):
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        for name, sql in conn.sql.items():
            if name.startswith("progress") or name == "activities":
                self.assertNotIn("collected_captures", sql)

    def test_third_party_verification_counts_toward_levels(self):
        """A confirmed claim can carry what the vendor's own claim could not."""
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        for name in ("progress_global", "activities"):
            self.assertIn("FROM public.verification_evidence ve", conn.sql[name])
            self.assertIn("ve.evidence_tier IS NOT NULL", conn.sql[name])
            self.assertIn("WHEN 'hands_on_test' THEN 3", conn.sql[name])

    def test_both_ceilings_are_in_the_query(self):
        """A gate and the evidence tier each bound the level; losing either inflates."""
        conn = FakeConn(dataset())
        publish.build(conn, "1.0.0")
        sql = conn.sql["progress_global"]
        self.assertIn("activity_gate_edges", sql)
        self.assertIn("LEAST(floor(ae.observed_level)", sql)
        # The minimum, not the maximum: a task needs all of its work done, and
        # taking the highest is what put baggage porters at 59%.
        self.assertIn("min(level)", sql)



class TopicsTests(unittest.TestCase):
    """A topic is published with who argued each answer and what weighs on it, and with no answer of its own."""

    TOPIC = "topic:replacement:accountant:b5615a30"

    def published(self, **more):
        checks = {"specific": True, "closed": True, "exclusive": True, "movable": True}
        data = dataset(
            topics=[{"topic_id": self.TOPIC, "question_type": "replacement", "object_key": "accountant",
                     "about_concept_id": "oaw:occupation:13-2011.00", "anchor_en": "Accountants and Auditors",
                     "anchor_zh": "会计师与审计师", "question_en": "Will AI replace most accountants?",
                     "question_zh_cn": "AI 会取代大多数会计吗？", "state": "proposed", "origin": "mined",
                     "checks": more.get("checks", checks), "opened_at": "2026-10-01T19:26:48+00:00"}],
            topic_options=[{"topic_id": self.TOPIC, "position": 1, "text_en": "Far fewer accountants are needed", "text_zh_cn": "会计需求大幅减少"},
                           {"topic_id": self.TOPIC, "position": 2, "text_en": "AI cannot do accounting work reliably", "text_zh_cn": "AI 做不了会计工作"}],
            topic_claims=[{"topic_id": self.TOPIC, "source_id": "1", "says": "says so", "quote": "The billable hour is in trouble.",
                           "position": 1, "account_handle": "Stranger", "canonical_url": "https://x.com/s/1",
                           "published_at": "2026-10-02T00:00:00+00:00", "views": 9},
                          {"topic_id": self.TOPIC, "source_id": "2", "says": "says so too", "quote": None,
                           "position": 1, "account_handle": "emollick", "canonical_url": "https://x.com/e/2",
                           "published_at": "2026-10-03T00:00:00+00:00", "views": None}],
            topic_panel=[{"handle": "emollick", "account_key": "x:emollick"}],
            topic_kinds=[{"id": "oaw:occupation:13-2011.00", "kind": "occupation", "label_en": "Accountants and Auditors", "label_zh_cn": "会计师与审计师"},
                         {"id": "oaw:occupation-group:13", "kind": "occupation_group", "label_en": "Business and Financial Operations", "label_zh_cn": None}],
            topic_parents=[{"child_id": "oaw:occupation:13-2011.00", "parent_id": "oaw:occupation-group:13"}],
            topic_evidence=[{"topic_id": self.TOPIC, "position": 2, "sign": "contradicts", "confidence": 0.91,
                             "event_id": "e9", "title": "Models beat 12 licensed accountants", "kind": "benchmark_result",
                             "occurred_at": "2026-10-01T19:26:48+00:00", "by_name": "mercor", "source_url": "https://x.com/m/9"}],
        )
        return publish.build(FakeConn(data), "1.0.0")["topics"]

    def test_each_answer_says_who_argued_it_and_what_weighs_on_it(self):
        (topic,) = self.published()
        self.assertEqual(topic["slug"], "replacement-accountant-b5615a30")
        self.assertEqual(topic["about"], {"id": "oaw:occupation:13-2011.00", "kind": "occupation",
                                          "en": "Accountants and Auditors", "zh-CN": "会计师与审计师"})
        first, second = topic["options"]
        self.assertEqual((first["accounts"], first["panel_accounts"], first["supports"], first["contradicts"]), (2, 1, 0, 0))
        self.assertEqual((second["accounts"], second["supports"], second["contradicts"]), (0, 0, 1))
        self.assertEqual(topic["group"], {"id": "oaw:occupation-group:13", "en": "Business and Financial Operations",
                                          "zh-CN": "Business and Financial Operations"})
        self.assertEqual(topic["sides"], "one_sided")
        self.assertEqual(topic["by_quarter"], {"2026-Q4": {"a": 2}})

    def test_an_account_the_panel_has_not_confirmed_is_marked_by_having_no_key(self):
        claims = {c["handle"]: c for c in self.published()[0]["claims"]}
        self.assertIsNone(claims["Stranger"]["account_key"])
        self.assertEqual(claims["emollick"]["account_key"], "x:emollick")

    def test_no_field_names_a_right_answer(self):
        (topic,) = self.published()
        for field in ("answer", "resolution", "outcome", "winner", "probability"):
            self.assertNotIn(field, topic)
            for option in topic["options"]:
                self.assertNotIn(field, option)

    def test_a_topic_that_failed_its_standard_is_not_published(self):
        self.assertEqual(self.published(checks={"specific": False, "closed": True, "exclusive": True, "movable": True}), [])


class SourcesTests(unittest.TestCase):
    def account(self, **over):
        return {"account_key": "x:examplelab", "handle": "ExampleLab", "platform": "x",
                "owner_kind": "person", "panel_role": "executive", "identity_grade": "official_bio",
                "identity_url": None, "language": "en", "focus": None,
                "avatar_url": "https://img.example/a.jpg", "platform_account_id": "42",
                "person_id": "person:1", "org_id": None, "name": "Example Person", "name_zh_cn": None, **over}

    def test_account_carries_its_owner_and_its_own_latest_posts(self):
        at = datetime(2026, 9, 1, tzinfo=timezone.utc)
        _, snapshot = build(dataset(
            source_accounts=[self.account()],
            source_affiliations=[{"person_id": "person:1", "org_id": "org:example", "org_name": "Example",
                                  "relation": "founder", "role_title": "CEO"}],
            source_totals=[{"account_external_id": "42", "posts": 7, "latest_post_at": at}],
            source_latest=[{"account_external_id": "42", "source_id": "src:1", "canonical_url": "https://x.com/e/1",
                            "published_at": at, "excerpt": "hello", "language": "en",
                            "metrics": {"likes": 3, "views": 90}, "captured_at": at, "n": 1}],
            source_followers=[{"account_key": "x:examplelab", "followers": 1000, "checked_at": at}]))
        source = snapshot["sources"][0]
        self.assertNotIn("platform_account_id", source)
        self.assertEqual(source["affiliations"], [{"org_id": "org:example", "org_name": "Example",
                                                   "relation": "founder", "role_title": "CEO"}])
        self.assertEqual((source["posts"], source["followers"], source["avatar_url"]),
                         (7, 1000, "https://img.example/a.jpg"))
        self.assertEqual(source["latest"][0]["excerpt"], "hello")
        self.assertEqual(source["latest"][0]["views"], 90)
        self.assertIn("NOT s.is_reply AND NOT s.is_repost", build()[0].sql["source_latest"])

    def test_nothing_collected_is_null_not_zero(self):
        _, snapshot = build(dataset(source_accounts=[self.account()]))
        source = snapshot["sources"][0]
        self.assertIsNone(source["posts"])
        self.assertIsNone(source["latest_post_at"])
        self.assertIsNone(source["followers"])
        self.assertEqual(source["latest"], [])

    def test_only_enabled_accounts_are_published(self):
        conn, _ = build(dataset())
        self.assertIn("a.panel_state = 'enabled' AND NOT a.excluded", conn.sql["source_accounts"])


if __name__ == "__main__":
    unittest.main()
