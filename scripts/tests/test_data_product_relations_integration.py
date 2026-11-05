"""Resolve subjects and persist adoption against real PostgreSQL, without model calls."""
import sys
import unittest
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from psycopg import sql
from data_pipeline.db import connect, migrate
from data_pipeline.product_relations import reconcile


class ProductRelations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = 'openaiwill_products_test_' + uuid.uuid4().hex
        with connect() as admin:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.remove_database)
        cls.conn = connect(cls.database)
        cls.addClassCleanup(cls.conn.close)
        migrate(cls.conn)
        cls.conn.execute("INSERT INTO org_registry (org_id, canonical_name_en, aliases, record_sha256) VALUES ('org:buyer', 'Buyer', '[]', %s)", ('a' * 64,))
        cls.conn.execute("INSERT INTO products (product_id, owner_name, name) VALUES ('product:acme:desk', 'Acme', 'Desk')")
        cls.conn.execute("""INSERT INTO models (model_id, owner_name, name, level, status, first_seen_event_id)
            VALUES ('model:acme:core', 'Acme', 'Core 3.5', 'release', 'confirmed', 'test')""")

    @classmethod
    def remove_database(cls):
        with connect() as admin:
            admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(cls.database)))

    def add(self, n, subject, role='adopter', evidence='own_use', review='machine_proposed', sourced=True, org='org:buyer'):
        oid = f'obs-{n:016x}'
        self.conn.execute('''INSERT INTO observations (observation_id, actor_key, actor_name, actor_role,
            subject_key, work_key, task, evidence_type, outcome, direction, extractor, schema_version,
            scale, review_state, reviewed_at, actor_org_id)
            VALUES (%s, 'unresolved:buyer', 'Buyer', %s, %s, 'unmapped', 'Answer tickets', %s,
                    'succeeded', 'ai_takes_on', 'test', '2.5.0', '100 tickets', %s,
                    CASE WHEN %s = 'machine_proposed' THEN NULL ELSE now() END, %s)''',
            (oid, role, subject, evidence, review, review, org))
        if sourced:
            self.conn.execute('''INSERT INTO observation_sources (source_ref, observation_id, source_type, url, quote)
                VALUES (%s, %s, 'case_page', 'https://example.test/case', 'Buyer uses Desk')''', (oid, oid))
        return oid

    def test_resolution_writes_only_supported_adoption_and_is_idempotent(self):
        product = self.add(1, 'Desk')
        model = self.add(2, 'Core 3.5', evidence='production_use')
        self.add(3, 'Desk', role='maker', evidence='vendor_claim')
        self.add(4, 'Desk', role='practitioner')
        self.add(5, 'Desk', evidence='demonstration')
        unknown = self.add(6, 'Unknown Desk')
        self.add(7, 'Desk', review='human_rejected')
        self.add(8, 'Desk', sourced=False)
        merged = self.add(9, 'Desk')
        self.conn.execute("""INSERT INTO observation_mapping_runs
            (run_id, mapper, model, embedding_model, prompt_sha256, counts, started_at)
            VALUES ('map-test', 'test', 'test', 'test', %s, '{}', now())""", ('a' * 64,))
        self.conn.execute("INSERT INTO observation_merges (observation_id, merged_into, run_id) VALUES (%s, %s, 'map-test')", (merged, product))
        self.add(10, 'Desk', org=None)
        self.conn.execute("""INSERT INTO models (model_id, owner_name, name, level, status, first_seen_event_id)
            VALUES ('model:acme:app', 'Acme', 'App', 'release', 'candidate', 'test'),
                   ('model:acme:family', 'Acme', 'Family', 'family', 'confirmed', 'test')""")
        self.add(11, 'App')
        self.add(12, 'Family')
        result = reconcile(self.conn)
        self.assertEqual(result['new_adoptions'], 2)
        self.assertEqual(result['resolved'], 6)
        adoptions = self.conn.execute('SELECT * FROM adoptions ORDER BY observation_id').fetchall()
        self.assertEqual(adoptions[0]['product_id'], 'product:acme:desk')
        self.assertEqual(adoptions[1]['model_id'], 'model:acme:core')
        self.assertEqual([a['stage'] for a in adoptions], ['in_use', 'production'])
        self.assertTrue(all(a['adopted_on'] is None for a in adoptions))
        self.assertEqual(adoptions[0]['scale'], '100 tickets')
        self.assertEqual(adoptions[0]['observation_id'], product)
        self.assertEqual(adoptions[1]['observation_id'], model)
        self.assertIsNone(self.conn.execute('SELECT subject_product_id FROM observations WHERE observation_id=%s',
                                           (unknown,)).fetchone()['subject_product_id'])
        again = reconcile(self.conn)
        self.assertEqual((again['newly_resolved'], again['new_adoptions']), (0, 0))
        self.assertEqual(self.conn.execute('SELECT subject_key FROM observations WHERE observation_id=%s',
                                           (product,)).fetchone()['subject_key'], 'Desk')

    def test_source_catalog_is_atomic_append_only_and_published(self):
        from data_pipeline.product_relations import import_catalog
        from data_pipeline.publish import product_relations
        doc = {
            'products': [{'product_id': 'product:acme:agent', 'owner_name': 'Acme', 'name': 'Agent'}],
            'availability': [{'availability_id': 'avail-1', 'product_id': 'product:acme:agent',
                              'as_of': '2026-11-01', 'stage': 'preview', 'source_url': 'https://example.test/preview'}],
            'investments': [{'investment_id': 'invest-1', 'investor_org_id': 'org:buyer',
                             'investee_org_id': 'org:maker', 'started_on': '2026-10-01',
                             'source_url': 'https://example.test/investment'}],
        }
        self.conn.execute("INSERT INTO org_registry (org_id, canonical_name_en, aliases, record_sha256) VALUES ('org:maker', 'Maker', '[]', %s)", ('b' * 64,))
        self.assertEqual(import_catalog(self.conn, doc)['inserted'], {'products': 1, 'availability': 1, 'investments': 1})
        self.assertEqual(import_catalog(self.conn, doc)['inserted'], {})
        rows = product_relations(self.conn)
        self.assertEqual(rows['product_availability'][0]['as_of'], '2026-11-01')
        self.assertEqual(rows['investments'][0]['started_on'], '2026-10-01')
        self.assertIsNone(rows['investments'][0]['ended_on'])
        with self.assertRaises(ValueError):
            import_catalog(self.conn, {'products': [{'product_id': 'product:acme:unsourced', 'owner_name': 'Acme', 'name': 'Unsourced'}]})
        self.assertIsNone(self.conn.execute("SELECT 1 FROM products WHERE product_id='product:acme:unsourced'").fetchone())
        with self.assertRaises(ValueError):
            import_catalog(self.conn, {'availability': [{**doc['availability'][0], 'stage': 'available'}]})
        with self.assertRaises(ValueError):
            import_catalog(self.conn, {'adoptions': [{'adoption_id': 'bad', 'org_id': 'org:buyer',
                 'adopter_name': 'Buyer', 'product_id': 'product:acme:agent', 'stage': 'production',
                 'observation_id': 'obs-0000000000000001'}]})
