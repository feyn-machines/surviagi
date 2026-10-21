"""Real PostgreSQL regressions for the judgment layer (migrations 006-008).

Two things are under test here, and they are different in kind:

  * the seeding contract of data_pipeline.type_layer - definitions are a
    projection of the schema and may be re-projected, while the proposed
    edge set is frozen once written, because an edge carries review state and a
    silent overwrite would erase the decision that matters;

  * the guards the schema itself enforces. Every CHECK exercised below exists
    because a Python-side rule is only as good as the last caller who remembered
    it: a machine proposal must never present itself as settled, an undecided
    answer must say what it got stuck on, a stage is never invented to fill an
    evidence gap, and an event under the controlled vocabulary must name a real
    organisation.

The ontology here is a stub: the real release has 20796 concepts and none of
these constraints care how many there are. Only the concepts the seeded edges
point at are created, and they are derived from the schema rather than
typed out, so a model that grows an edge does not silently skip these tests.
"""
import copy
import hashlib
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from psycopg import errors, sql

from data_pipeline import type_layer
from data_pipeline.db import connect, migrate
# The markers are half of the SQL CHECK; taking them from the schema keeps
# this file from becoming a second, silently diverging copy of the vocabulary.
from data_pipeline.ontology_schema import EVENT_KIND_VOCABULARIES, EVENT_KIND_VOCABULARY, LEGACY_VOCABULARY

# The constraints below are those of the first controlled vocabulary, whose rows
# name a company. A row of the current one names the account that acted instead.
NEW_VOCABULARY = EVENT_KIND_VOCABULARIES[0]

ONTOLOGY_VERSION = "semantic-test-ontology-1"
EXTRACTION_RUN_ID = "extract-semantic-layer-test"


def sha(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def concept_kind(concept_id):
    """ontology_concepts.kind for a stub row; O*NET tasks are work nodes."""
    if ":occupation:" in concept_id:
        return "occupation"
    if ":market:" in concept_id:
        return "market"
    return "work"


def seeded_concept_ids(model, ontology_version=ONTOLOGY_VERSION):
    """Concepts the constraint tests point at.

    This used to be read off the seeded capability edges. Seeding writes no
    edges now - the mapping passes do, under their own runs - so the stub
    carries one activity, one task and one occupation, which is everything the
    activity-layer CHECKs need to reference.
    """
    return ["oaw:market:stub-activity", "oaw:task:stub", "oaw:occupation:00-0000.00",
            "oaw:market:stub"]


def add_concept(conn, concept_id):
    conn.execute(
        """INSERT INTO ontology_concepts
           (ontology_version, id, kind, label_en, origin, translation_status, scope_status,
            record_sha256)
           VALUES (%s, %s, %s, %s, 'test-stub', 'not_translated', 'in_scope', %s)
           ON CONFLICT DO NOTHING""",
        (ONTOLOGY_VERSION, concept_id, concept_kind(concept_id), concept_id, sha(concept_id)))
    return concept_id


def seed_stub_ontology(conn):
    """A minimal ontology release carrying only the concepts the seed edges need."""
    conn.execute(
        """INSERT INTO ontology_releases (version, schema_version, manifest_sha256)
           VALUES (%s, '1.0.0', %s)""", (ONTOLOGY_VERSION, sha(ONTOLOGY_VERSION)))
    for concept_id in seeded_concept_ids(type_layer.load_schema()):
        add_concept(conn, concept_id)


def create_database(label):
    name = f"openaiwill_{label}_test_" + uuid.uuid4().hex
    with connect() as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    return name


def drop_database(name):
    with connect() as admin:
        admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


class SeedingTest(unittest.TestCase):
    """Each test needs an unseeded database, so the database is per-test here."""

    def setUp(self):
        self.database = create_database("semantic_seed")
        self.addCleanup(drop_database, self.database)
        self.conn = connect(self.database)
        self.addCleanup(self.conn.close)
        migrate(self.conn)
        seed_stub_ontology(self.conn)
        self.document = type_layer.seed_document(type_layer.load_schema(), ONTOLOGY_VERSION)

    def count(self, table):
        return self.conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]

    def counts(self):
        return {name: self.count(name) for name in ("org_registry", "gates")}

    def test_seeding_twice_is_reused_and_duplicates_nothing(self):
        first = type_layer.seed(self.conn, ONTOLOGY_VERSION)
        self.assertFalse(first["reused"])
        after_first = self.counts()
        self.assertEqual(after_first, {
            "org_registry": len(self.document["organizations"]),
            "gates": len(self.document["gates"]),
        })
        type_layer.seed(self.conn, ONTOLOGY_VERSION)
        self.assertEqual(self.counts(), after_first)

    def test_definitions_are_a_projection_and_may_be_reprojected(self):
        """A definition is a type, so correcting the file corrects the row.

        Edges are the opposite and are no longer written here at all: they carry
        review state, and the mapping passes write them under their own runs.
        """
        type_layer.seed(self.conn, ONTOLOGY_VERSION)
        gate_id = self.document["gates"][0]["gate_id"]
        before = self.conn.execute(
            "SELECT definition_en, record_sha256 FROM gates WHERE gate_id=%s",
            (gate_id,)).fetchone()

        edited = copy.deepcopy(type_layer.load_gates())
        target = next(g for g in edited["gates"] if g["id"] == gate_id)
        target["definition"]["en"] = "Redefined after review: " + target["definition"]["en"]
        with mock.patch.object(type_layer, "load_gates", return_value=edited):
            type_layer.seed(self.conn, ONTOLOGY_VERSION)

        after = self.conn.execute(
            "SELECT definition_en, record_sha256 FROM gates WHERE gate_id=%s",
            (gate_id,)).fetchone()
        self.assertEqual(after["definition_en"], target["definition"]["en"])
        self.assertNotEqual(after["record_sha256"], before["record_sha256"])
        self.assertEqual(self.count("gates"), len(self.document["gates"]))

    def test_seeding_writes_no_edges_and_opens_no_run(self):
        """The capability seed opened a judgment run to own its twelve edges.

        There are no edges to own: gates attach to activities through the
        mapping pass, which records its own run and its own checkpoints.
        """
        type_layer.seed(self.conn, ONTOLOGY_VERSION)
        self.assertEqual(self.count("judgment_runs"), 0)
        self.assertEqual(self.count("activity_gate_edges"), 0)


class ConstraintTest(unittest.TestCase):
    """The guards the schema enforces itself, exercised against a seeded database."""

    @classmethod
    def setUpClass(cls):
        cls.database = create_database("semantic_layer")
        cls.addClassCleanup(drop_database, cls.database)
        with connect(cls.database) as conn:
            migrate(conn)
            seed_stub_ontology(conn)
            type_layer.seed(conn, ONTOLOGY_VERSION)
            conn.execute(
                """INSERT INTO extraction_runs
                   (run_id, collection_run_ids, model, prompt_sha256, params, started_at,
                    finished_at, status, run_sha256, candidate_count, event_count)
                   VALUES (%s, '[]'::jsonb, 'test', %s, '{}'::jsonb, now(), now(), 'completed',
                           %s, 0, 0)""",
                (EXTRACTION_RUN_ID, sha("prompt"), sha("run")))

    def setUp(self):
        self.conn = connect(self.database)
        self.addCleanup(self.conn.close)
        self.uid = uuid.uuid4().hex[:8]
        self.gate = self.conn.execute(
            "SELECT gate_id FROM gates ORDER BY gate_id LIMIT 1").fetchone()["gate_id"]
        self.activity = "oaw:market:stub-activity"
        self.task = "oaw:task:stub"
        self.run = self.judgment_run()

    # --- helpers ---------------------------------------------------------------

    def judgment_run(self):
        run_id = f"run-test-{uuid.uuid4().hex[:10]}"
        self.conn.execute(
            """INSERT INTO judgment_runs
               (run_id, judge, model, task, prompt_sha256, rubric_sha256, method_version,
                params, started_at, finished_at, status, item_count, decided_count, run_sha256)
               VALUES (%s, 'typesafe', 'test', 'demonstrates', %s, %s, 'test-1',
                       '{}'::jsonb, now(), now(), 'completed', 0, 0, %s)""",
            (run_id, sha("p"), sha("r"), sha(run_id)))
        return run_id

    def new_concept(self):
        """A fresh ontology concept, so each row gets its own primary key."""
        return add_concept(self.conn, f"oaw:task:test-{self.uid}-{uuid.uuid4().hex[:8]}")

    def insert_task_edge(self, **overrides):
        row = {"ontology_version": ONTOLOGY_VERSION, "activity_id": self.activity,
               "task_id": self.new_concept(), "judge": "typesafe", "method": "ai_proposed",
               "status": "candidate", "confidence": None, "rationale": "test row",
               "judgment_run_id": self.run, "reviewed_by": None, "reviewed_at": None,
               "record_sha256": sha(self.uid)}
        row.update(overrides)
        self.conn.execute(
            """INSERT INTO activity_task_edges
               (ontology_version, activity_id, task_id, judge, method, status, confidence,
                rationale, judgment_run_id, reviewed_by, reviewed_at, record_sha256)
               VALUES (%(ontology_version)s,%(activity_id)s,%(task_id)s,%(judge)s,%(method)s,
                %(status)s,%(confidence)s,%(rationale)s,%(judgment_run_id)s,%(reviewed_by)s,
                %(reviewed_at)s,%(record_sha256)s)""", row)
        return row

    def insert_reading(self, **overrides):
        event = self.insert_event()
        row = {"event_id": event["event_id"], "activity_id": self.activity,
               "ontology_version": ONTOLOGY_VERSION, "evidence_tier": "T3",
               "evidence_sign": "positive", "observed_level": 2, "confidence": None,
               "judge": "typesafe", "method": "ai_proposed", "status": "candidate",
               "rationale": "test row", "judgment_run_id": self.run,
               "reviewed_by": None, "reviewed_at": None, "record_sha256": sha(self.uid)}
        row.update(overrides)
        self.conn.execute(
            """INSERT INTO activity_evidence
               (event_id, activity_id, ontology_version, evidence_tier, evidence_sign,
                observed_level, confidence, judge, method, status, rationale,
                judgment_run_id, reviewed_by, reviewed_at, record_sha256)
               VALUES (%(event_id)s,%(activity_id)s,%(ontology_version)s,%(evidence_tier)s,
                %(evidence_sign)s,%(observed_level)s,%(confidence)s,%(judge)s,%(method)s,
                %(status)s,%(rationale)s,%(judgment_run_id)s,%(reviewed_by)s,%(reviewed_at)s,
                %(record_sha256)s)""", row)
        return row

    def insert_event(self, **overrides):
        key = uuid.uuid4().hex[:12]
        row = {"event_id": f"ev-test-{key}", "dedup_key": f"dedup-test-{key}",
               "kind": "product_launch", "kind_vocabulary": NEW_VOCABULARY,
               "unresolved_reason": None, "subject_key": "subject-" + key,
               "identity_confidence": "high", "title": "t", "summary": "s",
               "primary_org": "OpenAI", "primary_org_id": "org:openai",
               "occurrence_status": "occurred", "first_extraction_run_id": EXTRACTION_RUN_ID,
               "confidence": None, "record_sha256": sha(key)}
        row.update(overrides)
        self.conn.execute(
            """INSERT INTO extracted_events
               (event_id, dedup_key, kind, kind_vocabulary, unresolved_reason, subject_key,
                identity_confidence, title, summary, primary_org, primary_org_id,
                occurrence_status, first_extraction_run_id, confidence, record_sha256)
               VALUES (%(event_id)s,%(dedup_key)s,%(kind)s,%(kind_vocabulary)s,
                %(unresolved_reason)s,%(subject_key)s,%(identity_confidence)s,%(title)s,
                %(summary)s,%(primary_org)s,%(primary_org_id)s,%(occurrence_status)s,
                %(first_extraction_run_id)s,%(confidence)s,%(record_sha256)s)""", row)
        return row

    def test_a_machine_proposal_can_never_present_itself_as_settled(self):
        """rule:ai-proposed-cannot-assert-equivalence, enforced by the schema.

        A Python-side rule is only as good as the last caller who remembered it.
        Every edge on this site is ai_proposed and nothing has been reviewed, so
        this CHECK is the thing standing between a proposal and a claim.
        """
        for table, insert in (("activity_task_edges", self.insert_task_edge),
                              ("activity_evidence", self.insert_reading)):
            with self.subTest(table=table):
                with self.assertRaises(errors.CheckViolation):
                    insert(status="reviewed")

    def test_a_reviewed_row_needs_a_reviewer_and_a_time(self):
        for table, insert in (("activity_task_edges", self.insert_task_edge),
                              ("activity_evidence", self.insert_reading)):
            with self.subTest(table=table):
                with self.assertRaises(errors.CheckViolation):
                    insert(method="reviewed", status="reviewed")

    def test_the_vocabulary_terms_the_capability_era_dropped_are_accepted(self):
        """Migration 021. The activity tables enumerated ('ai_proposed',
        'reviewed', 'imported') - inventing `imported`, which relation_method
        does not contain, and losing `source_id`, which marks an edge that came
        from the source data rather than from a judge."""
        row = self.insert_task_edge(method="source_id", status="source_reference")
        self.assertEqual(row["method"], "source_id")
        with self.assertRaises(errors.CheckViolation):
            self.insert_task_edge(method="imported")

    def test_an_unrecognised_evidence_tier_is_refused(self):
        """Migration 021. evidence_tier had no CHECK at all, and it is the
        column the cap reads: an unknown tier caps at NULL, LEAST(level, NULL)
        is NULL, and the reading vanishes instead of failing."""
        with self.assertRaises(errors.CheckViolation):
            self.insert_reading(evidence_tier="T5")

    def test_a_level_outside_the_ladder_is_refused(self):
        for level in (-1, 6):
            with self.subTest(level=level):
                with self.assertRaises(errors.CheckViolation):
                    self.insert_reading(observed_level=level)

    def test_a_reading_with_no_level_is_allowed_and_is_not_a_zero(self):
        """"Asked and nothing resolved" is a state. Storing it as 0 would say
        the evidence showed AI taking no part, which is a different finding."""
        row = self.insert_reading(observed_level=None)
        stored = self.conn.execute(
            "SELECT observed_level FROM activity_evidence WHERE event_id=%s",
            (row["event_id"],)).fetchone()["observed_level"]
        self.assertIsNone(stored)

    def test_new_vocabulary_rejects_a_legacy_kind(self):
        with self.assertRaises(errors.CheckViolation):
            self.insert_event(kind_vocabulary=NEW_VOCABULARY, kind="launch")

    def test_new_vocabulary_allows_a_null_kind_with_a_reason(self):
        row = self.insert_event(kind=None, unresolved_reason="no rubric term fits",
                                identity_confidence="low")
        stored = self.conn.execute(
            "SELECT kind, unresolved_reason FROM extracted_events WHERE event_id=%s",
            (row["event_id"],)).fetchone()
        self.assertEqual(stored, {"kind": None, "unresolved_reason": "no rubric term fits"})

    def test_null_kind_without_a_reason_should_be_rejected(self):
        """rule:no-other-bucket, enforced in SQL: a null kind needs a reason.

        Regression guard for a defect this test found. The constraint generated
        into 006 read `(marker = '...' AND kind IN (...)) OR ...`, and `kind IN
        (...)` is NULL when kind is NULL, so the whole expression evaluated to
        NULL rather than FALSE and PostgreSQL accepted the row - the guard the
        schema comment promised had never rejected anything. Repaired in
        db/migrations/009_kind_check_null_repair.sql by testing IS NULL and
        IS NOT NULL explicitly in every branch.
        """
        with self.assertRaises(errors.CheckViolation):
            self.insert_event(kind=None, unresolved_reason=None)
        with self.assertRaises(errors.CheckViolation):
            self.insert_event(kind=None, unresolved_reason="")

    def test_new_vocabulary_event_must_name_an_organisation_id(self):
        with self.assertRaises(errors.CheckViolation):
            self.insert_event(primary_org_id=None)
        with self.assertRaises(errors.ForeignKeyViolation):
            self.insert_event(primary_org_id="org:not-registered")

    def test_a_current_vocabulary_event_must_name_the_account_that_acted(self):
        with self.assertRaises(errors.CheckViolation):
            self.insert_event(kind_vocabulary=EVENT_KIND_VOCABULARY, primary_org_id=None)

    def test_the_kinds_added_later_are_refused_under_the_earlier_marker(self):
        with self.assertRaises(errors.CheckViolation):
            self.insert_event(kind="usage_report")

    def test_legacy_rows_keep_their_old_kinds_and_need_no_org_id(self):
        row = self.insert_event(kind_vocabulary=LEGACY_VOCABULARY, kind="launch",
                                primary_org_id=None, subject_key=None,
                                identity_confidence=None)
        self.assertEqual(self.conn.execute(
            "SELECT kind, kind_vocabulary FROM extracted_events WHERE event_id=%s",
            (row["event_id"],)).fetchone(),
            {"kind": "launch", "kind_vocabulary": LEGACY_VOCABULARY})

    # --- gate lifecycle ---------------------------------------------------------

    def insert_gate(self, **overrides):
        row = {"gate_id": f"gate:test-{uuid.uuid4().hex[:8]}", "gate_type": "physical_presence",
               "label_en": "l", "label_zh_cn": None, "definition_en": "d",
               "definition_zh_cn": None, "lifecycle": "active", "replaced_by": None,
               "obsolescence_reason": None, "record_sha256": sha(self.uid)}
        row.update(overrides)
        self.conn.execute(
            """INSERT INTO gates
               (gate_id, gate_type, label_en, label_zh_cn, definition_en, definition_zh_cn,
                lifecycle, replaced_by, obsolescence_reason, record_sha256)
               VALUES (%(gate_id)s,%(gate_type)s,%(label_en)s,%(label_zh_cn)s,%(definition_en)s,
                %(definition_zh_cn)s,%(lifecycle)s,%(replaced_by)s,%(obsolescence_reason)s,
                %(record_sha256)s)""", row)
        return row

    def test_a_deprecated_gate_must_say_what_replaced_it_or_why(self):
        """rule:deprecated-needs-replacement. A gate that simply disappears
        makes every activity it held look like it was never held."""
        with self.assertRaises(errors.CheckViolation):
            self.insert_gate(lifecycle="deprecated")
        replacement = self.insert_gate()
        row = self.insert_gate(lifecycle="deprecated", replaced_by=replacement["gate_id"])
        self.assertEqual(self.conn.execute(
            "SELECT replaced_by FROM gates WHERE gate_id=%s",
            (row["gate_id"],)).fetchone()["replaced_by"], replacement["gate_id"])
        reasoned = self.insert_gate(lifecycle="deprecated",
                                    obsolescence_reason="folded into another gate")
        self.assertEqual(self.conn.execute(
            "SELECT lifecycle FROM gates WHERE gate_id=%s",
            (reasoned["gate_id"],)).fetchone()["lifecycle"], "deprecated")


if __name__ == "__main__":
    unittest.main()
