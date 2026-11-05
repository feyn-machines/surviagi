"""Exact subject resolution and observation-backed adoption (Issue #76).

No model calls and no guessing from a version, a substring or a model used by
an app. The original subject and observation identity are never rewritten.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import unicodedata


def surface(value):
    """Case and separator differences only; retain digits and non-Latin names."""
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in
                           unicodedata.normalize('NFKC', value or '').casefold()).split())


def subject_index(products, models, aliases):
    index = defaultdict(set)
    for kind, rows, key in [('product', products, 'product_id'), ('model', models, 'model_id')]:
        for row in rows:
            for name in (row['name'], row[key]):
                index[surface(name)].add((kind, row[key]))
    for row in aliases:
        index[surface(row['alias'])].add(('model', row['model_id']))
    return index


def resolve(index, names):
    """All known surface forms must agree; a cross-class collision is unresolved."""
    if not names or any(not index.get(surface(name)) for name in names):
        return None
    matches = set().union(*(index.get(surface(name), set()) for name in names))
    return next(iter(matches)) if len(matches) == 1 else None


def reconcile(conn):
    """Fill unresolved subjects, then derive only explicit adopter own-use rows.

    Uses the same lock as observation ingestion. Existing resolutions are kept;
    rejected and merged-away observations are excluded. Model families and
    unconfirmed model candidates stay unresolved (an app can share a family
    name). Automatic adoption requires a registered organization; an actor's
    role alone does not prove it is an organization. A named practitioner is
    not presumed to be an organization. No announcement becomes a deployment.
    """
    with conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(7543025)')
        index = subject_index(
            conn.execute('SELECT product_id, name FROM products').fetchall(),
            conn.execute("SELECT model_id, name FROM models WHERE status = 'confirmed' AND level = 'release'").fetchall(),
            conn.execute("""SELECT a.alias, a.model_id FROM model_aliases a JOIN models m USING (model_id)
                WHERE m.status = 'confirmed' AND m.level = 'release'""").fetchall())
        names = defaultdict(list)
        for row in conn.execute('SELECT observation_id, subject FROM observation_readings ORDER BY run_id'):
            if row['subject']:
                names[row['observation_id']].append(row['subject'])
        rows = conn.execute('''SELECT o.* FROM observations o
            WHERE review_state <> 'human_rejected'
              AND NOT EXISTS (SELECT 1 FROM observation_merges m WHERE m.observation_id = o.observation_id)
              AND EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.observation_id)
            ORDER BY observation_id''').fetchall()
        newly_resolved = adopted = 0
        for row in rows:
            oid = row['observation_id']
            if not row['subject_product_id'] and not row['subject_model_id']:
                # Prefer the original wording. The slug is only a fallback for
                # older records without a reading; a slug loses punctuation.
                match = resolve(index, names.get(oid) or [row['subject_key']])
                if match:
                    kind, identifier = match
                    row['subject_product_id'] = identifier if kind == 'product' else None
                    row['subject_model_id'] = identifier if kind == 'model' else None
                    conn.execute('''UPDATE observations SET subject_product_id = %s, subject_model_id = %s
                                    WHERE observation_id = %s''',
                                 (row['subject_product_id'], row['subject_model_id'], oid))
                    newly_resolved += 1
            if (bool(row['subject_product_id']) == bool(row['subject_model_id'])
                    or row['actor_role'] != 'adopter' or not row['actor_org_id']
                    or row['evidence_type'] not in ('own_use', 'production_use')):
                continue
            stage = 'production' if row['evidence_type'] == 'production_use' else 'in_use'
            if conn.execute('SELECT 1 FROM adoptions WHERE observation_id = %s AND stage = %s',
                            (oid, stage)).fetchone():
                continue
            aid = 'adoption-' + hashlib.sha256((oid + '\n' + stage).encode()).hexdigest()[:16]
            inserted = conn.execute('''INSERT INTO adoptions
                (adoption_id, org_id, adopter_name, product_id, model_id, stage, adopted_on, scale, observation_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (adoption_id) DO NOTHING RETURNING adoption_id''',
                (aid, row['actor_org_id'], row['actor_name'], row['subject_product_id'], row['subject_model_id'],
                 stage, row['occurred_on'], row['scale'], oid)).fetchone()
            adopted += inserted is not None
        unresolved = Counter(row['subject_key'] for row in rows
                             if not row['subject_product_id'] and not row['subject_model_id'])
        total = len(rows)
        resolved = total - sum(unresolved.values())
        return {'observations': total, 'resolved': resolved, 'newly_resolved': newly_resolved,
                'resolved_fraction': resolved / total if total else None,
                'new_adoptions': adopted,
                'adoptions': conn.execute('''SELECT count(*) AS n FROM adoptions a JOIN observations o USING (observation_id)
                    WHERE o.review_state <> 'human_rejected' AND NOT EXISTS
                    (SELECT 1 FROM observation_merges m WHERE m.observation_id = o.observation_id)''').fetchone()['n'],
                'unresolved': [{'name': name, 'observations': count} for name, count in unresolved.most_common(20)]}


# Import projections of the existing ontology tables, not an extraction format.
# Every relationship carries the source that supports it. Unknown stays null.
IMPORTS = {
    'products': ('products', 'product_id', ('product_id', 'org_id', 'owner_name', 'name', 'category')),
    'availability': ('product_availability', 'availability_id',
                     ('availability_id', 'product_id', 'as_of', 'stage', 'channel', 'region', 'audience', 'price', 'source_url')),
    'investments': ('org_investments', 'investment_id',
                    ('investment_id', 'investor_org_id', 'investee_org_id', 'stake', 'started_on', 'ended_on', 'source_url')),
    'adoptions': ('adoptions', 'adoption_id',
                  ('adoption_id', 'org_id', 'adopter_name', 'product_id', 'model_id', 'stage', 'adopted_on', 'scale', 'observation_id')),
}


def import_catalog(conn, doc):
    """Append a source-backed catalog document atomically; conflicting ids fail.

    This is a curated input, not an inference from a URL. Its source URLs and
    dates must be checked by its author. Availability gives every new product
    its dated source. Explicit adoption must agree with a sourced observation's
    actor and resolved subject. No document can change an existing row.
    """
    from datetime import date, datetime
    from urllib.parse import urlsplit
    from psycopg import sql
    from .pipeline import digest

    if not isinstance(doc, dict) or set(doc) - set(IMPORTS):
        raise ValueError('Unknown catalog sections')
    inserted = Counter()
    with conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(7543025)')
        for section, (table, key, columns) in IMPORTS.items():
            items = doc.get(section, [])
            if not isinstance(items, list):
                raise ValueError(f'{section} must be a list')
            for item in items:
                if not isinstance(item, dict) or set(item) - set(columns) or not item.get(key):
                    raise ValueError(f'Invalid {section} row')
                row = {column: item.get(column) for column in columns}
                if 'source_url' in row:
                    url = urlsplit(row['source_url'] or '')
                    if url.scheme not in ('http', 'https') or not url.netloc:
                        raise ValueError(f'{section} needs an HTTP source URL')
                if section == 'adoptions':
                    observation = conn.execute('''SELECT o.* FROM observations o
                        WHERE observation_id = %s AND review_state <> 'human_rejected'
                          AND EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.observation_id)
                          AND NOT EXISTS (SELECT 1 FROM observation_merges m WHERE m.observation_id = o.observation_id)''',
                        (row['observation_id'],)).fetchone()
                    if (not observation or observation['actor_role'] != 'adopter'
                            or row['product_id'] != observation['subject_product_id']
                            or row['model_id'] != observation['subject_model_id']
                            or row['org_id'] != observation['actor_org_id']
                            or row['adopter_name'] != observation['actor_name']):
                        raise ValueError('Adoption must agree with a sourced adopter observation')
                if section == 'adoptions' and conn.execute(
                        'SELECT 1 FROM adoptions WHERE observation_id = %s AND stage = %s AND adoption_id <> %s',
                        (row['observation_id'], row['stage'], row[key])).fetchone():
                    raise ValueError('This observation and adoption stage already have a record')
                old = conn.execute(sql.SQL('SELECT {} FROM {} WHERE {} = %s').format(
                    sql.SQL(', ').join(map(sql.Identifier, columns)), sql.Identifier(table), sql.Identifier(key)),
                    (row[key],)).fetchone()
                if old:
                    normalized = {k: v.isoformat() if isinstance(v, (date, datetime)) else v for k, v in old.items()}
                    if normalized != row:
                        raise ValueError(f'Conflicting {section} id: {row[key]}')
                    continue
                conn.execute(sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(
                    sql.Identifier(table), sql.SQL(', ').join(map(sql.Identifier, columns)),
                    sql.SQL(', ').join(sql.Placeholder() for _ in columns)), list(row.values()))
                inserted[section] += 1
        for product in doc.get('products', []):
            if not conn.execute('SELECT 1 FROM product_availability WHERE product_id = %s',
                                (product['product_id'],)).fetchone():
                raise ValueError('A product needs a dated availability source')
    return {'document_sha256': digest(doc), 'inserted': dict(inserted)}
