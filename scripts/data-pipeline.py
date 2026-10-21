#!/usr/bin/env python3
"""Run the local collection -> PostgreSQL -> activity level -> published snapshot pipeline."""
import argparse
import copy
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import sys

from data_pipeline.db import connect, migrate
from data_pipeline.pipeline import ROOT, import_ontology


def json_default(value):
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=json_default) + '\n')


def run_event_extraction(conn, args):
    """Query candidates from the collection store, call DeepSeek, land the event layer."""
    from data_pipeline import deepseek
    from data_pipeline.event_extraction import (load_candidates, assemble_extraction,
                                                ingest_extraction, load_known_occurrences,
                                                load_known_events, load_prior)
    deepseek.load_env(ROOT)
    out = args.output
    if out.exists():
        raise ValueError(f'Output already exists (extraction runs are immutable): {out}')
    window = {'start': args.window_start, 'end': args.window_end} if (args.window_start or args.window_end) else None
    migrate(conn)
    candidates = load_candidates(conn, window=window,
                                 collection_run_ids=args.collection_run or None, limit=args.limit,
                                 targets=args.targets)
    if not candidates:
        raise ValueError('No extraction candidates matched (check --window-start/--end and --collection-run)')
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.plan_only:
        save(out, {'plan_only': True, 'candidate_count': len(candidates),
                   'collection_run_ids': sorted({c['run_id'] for c in candidates}), 'candidates': candidates})
        print(json.dumps({'plan_only': True, 'candidates': len(candidates), 'output': str(out)}, ensure_ascii=False))
        return
    cfg = deepseek.config_from_env()
    started = datetime.now(timezone.utc).isoformat()
    print(f'Extracting {len(candidates)} candidates via {cfg["model"]} (batch {args.batch_size})...', file=sys.stderr)
    known = load_known_events(conn, candidates)
    batches, failures = deepseek.extract_events(
        candidates, cfg, batch_size=args.batch_size, known=known, workers=args.workers,
        progress=lambda done, total, n: print(f'  batch {done}/{total}: {n} events', file=sys.stderr))
    if failures and len(failures) == len(batches):
        raise ValueError(f'Every extraction batch failed; first error: {failures[0]["error"]}')
    if failures:
        print(f'  WARNING: {len(failures)} of {len(batches)} batches failed and were skipped', file=sys.stderr)
    meta = {'model': cfg['model'], 'prompt_sha256': deepseek.prompt_sha256(),
            'params': {'batch_size': args.batch_size, 'limit': args.limit, 'failed_batches': failures,
                       'targets': args.targets, 'known_events': len(known)},
            'window': window, 'started_at': started,
            'finished_at': datetime.now(timezone.utc).isoformat(), 'status': 'completed'}
    doc = assemble_extraction(candidates, batches, meta,
                              known_occurrences=load_known_occurrences(conn),
                              known_events={item['ref']: item for item in known},
                              prior=load_prior(conn, candidates))
    save(out, doc)
    result = ingest_extraction(conn, out)
    print(json.dumps({'output': str(out), **result}, ensure_ascii=False, indent=2, default=json_default))



# The four mapping passes share one shape: one subject, a few hundred candidate
# options, a checkpoint per subject decided. Registering them from a table keeps
# that sameness visible - and keeps them registered at all. They ran for weeks by
# hand while the CLI still only knew the capability passes they replaced.
MAPPING_PASSES = {
    'route-events': ('event_routing',
                     'Which activities does each update bear on, and at what level'),
    'map-activities': ('activity_mapping',
                       'Which tasks does each market activity cover'),
    'map-markets': ('market_mapping',
                    'Which occupations serve each market'),
    'map-gates': ('gate_mapping',
                  'Which gates hold each activity back'),
}


def run_mapping_pass(conn, module_name, args):
    """Run one mapping pass and print what it decided, including what it kept nothing from."""
    import importlib
    module = importlib.import_module(f'data_pipeline.{module_name}')
    migrate(conn)
    result = module.run(
        conn, limit=args.limit, resume=not args.no_resume, note=args.note,
        progress=lambda message: print(message, file=sys.stderr),
        **({'ontology_version': args.ontology_version} if args.ontology_version else {}))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('migrate')
    # The sealed ontology release is the world this whole pipeline measures. It
    # used to ride along inside the synthetic `import` command, which meant the
    # only way to load the real concepts was to run the fixture importer.
    onto = sub.add_parser('import-ontology',
                          help='Load the sealed ontology release into PostgreSQL')
    onto.add_argument('--path', type=Path)
    ingest = sub.add_parser('ingest')
    ingest.add_argument('run', type=Path)
    extract = sub.add_parser('extract-events')
    extract.add_argument('--output', required=True, type=Path)
    extract.add_argument('--window-start')
    extract.add_argument('--window-end')
    extract.add_argument('--collection-run', action='append')
    extract.add_argument('--limit', type=int)
    extract.add_argument('--batch-size', type=int, default=20)
    extract.add_argument('--targets', choices=['official', 'panel', 'search', 'all'], default='all',
                         help='Whose posts to read: official company accounts, the panel, authors found by search, or all')
    extract.add_argument('--workers', type=int, default=4, help='Batches sent at once')
    extract.add_argument('--plan-only', action='store_true')
    topics = sub.add_parser('mine-topics', help='Read a window of posts for claims and place them under topics')
    topics.add_argument('--output', required=True, type=Path,
                        help='The record of this run; its file name is the run id')
    topics.add_argument('--window-start', required=True)
    topics.add_argument('--window-end', required=True)
    topics.add_argument('--claims-from', type=Path, help='Place the claims of an earlier run instead of reading posts again')
    topics.add_argument('--no-store', action='store_true', help='Write the record only; leave the database as it is')
    topics.add_argument('--collection-run', action='append', help='Read only the posts of this collection run')
    topics.add_argument('--limit', type=int)
    topics.add_argument('--workers', type=int, default=4, help='Batches sent at once')
    plan = sub.add_parser('topic-queries', help='Write the phrases to search next for the topics that most need another voice')
    plan.add_argument('--output', required=True, type=Path, help='One phrase per line, for `pnpm crawl search --queries-file`')
    plan.add_argument('--limit', type=int, default=20, help='Topics to search for')
    plan.add_argument('--per-topic', type=int, default=2)
    plan.add_argument('--votes', type=Path,
                      help='A file written by `pnpm votes:pull`; default is the newest one under data/votes/')
    searched = sub.add_parser('topic-searched', help='Record which topics a search run was made for')
    searched.add_argument('run', type=Path)
    reword = sub.add_parser('topic-reword', help='Rewrite stored answers that are longer than the standard allows; ids stay')
    reword.add_argument('--reason', required=True, help='Why the answers are being reworded; kept with the old wording')
    evidence = sub.add_parser('topic-evidence', help='Ask the judge which answers of which topics each update is evidence for or against')
    evidence.add_argument('--since', help='Only updates that happened on or after this time')
    evidence.add_argument('--limit', type=int)
    evidence.add_argument('--note', default='')
    sub.add_parser('measure-markets', help='Say which market or occupation each market measurement is about')
    index = sub.add_parser('search-index', help='Fill the search indexes from the database and the topics document')
    index.add_argument('--only', action='append', choices=['topics', 'updates', 'catalog'])
    find = sub.add_parser('search', help='Search one index by words and meaning together')
    find.add_argument('query')
    find.add_argument('--index', choices=['topics', 'updates', 'catalog'], default='topics')
    find.add_argument('--limit', type=int, default=8)
    find.add_argument('--semantic', type=float, default=0.5, help='0 words only, 1 meaning only')
    ingest_events = sub.add_parser('ingest-events')
    ingest_events.add_argument('archive', type=Path)
    seed = sub.add_parser('seed-ontology-data')
    seed.add_argument('--ontology-version')
    gs = sub.add_parser('gate-state')
    gs.add_argument('--vocabulary', default=None, help='One marker only; default is every version of event_kind')
    pub = sub.add_parser('publish-snapshot')
    pub.add_argument('--ontology-version')
    for name, (_, help_text) in MAPPING_PASSES.items():
        mp = sub.add_parser(name, help=help_text)
        mp.add_argument('--ontology-version')
        mp.add_argument('--limit', type=int)
        # Resume is the default: a subject already decided under this method
        # version has nothing new to say. Bumping METHOD_VERSION is how a pass is
        # invalidated, so this flag is for debugging one subject, not for reruns.
        mp.add_argument('--no-resume', action='store_true')
        mp.add_argument('--note', default='')
    pimp = sub.add_parser('panel-import',
                          help='Load a panel research draft; idempotent, nothing is enabled by it')
    pimp.add_argument('draft', type=Path)
    oimp = sub.add_parser('official-import',
                          help='Load the official account registry into source_accounts; idempotent')
    oimp.add_argument('registry', type=Path, nargs='?', default=Path('datasets/official-x-accounts.json'))
    limp = sub.add_parser('panel-lookup-import', help='Record a crawler lookup run as panel checks')
    limp.add_argument('run', type=Path)
    rb = sub.add_parser('relations-backfill',
                        help='Fill reply/repost/thread links and full text from crawler raw pages')
    rb.add_argument('runs', type=Path, nargs='+')
    sub.add_parser('post-events', help='Rebuild which posts belong to which event (derived, no requests)')
    ver = sub.add_parser('verify',
                         help='Judge ingested panel posts against held-down vendor claims (judge calls)')
    ver.add_argument('--plan-only', action='store_true',
                     help='List the triggered updates; no judge calls')
    ver.add_argument('--limit-events', type=int)
    idm = sub.add_parser('identify-models',
                         help='Which models each update names, and in what role (judge calls)')
    idm.add_argument('--limit', type=int)
    idm.add_argument('--batch-size', type=int, default=8)
    idm.add_argument('--report', action='store_true', help='Print the counts; no judge calls')
    idm.add_argument('--reconcile', action='store_true',
                     help='Fold short-name duplicates into their model and add short aliases; no judge calls')
    cat = sub.add_parser('model-catalog',
                         help='Import our companies\' recent models from a models.dev snapshot (no judge calls)')
    cat.add_argument('snapshot', type=Path, nargs='?', help='Saved api.json; downloaded when omitted')
    sub.add_parser('panel-refresh',
                   help='Re-derive every panel account\'s use and state from its checks')
    state = sub.add_parser('activity-state',
                           help='Fold activity evidence into task levels; no judge is called')
    state.add_argument('--ontology-version', default='1.0.0')
    args = parser.parse_args()
    with connect() as conn:
        if args.command == 'import-ontology':
            migrate(conn)
            print(json.dumps(import_ontology(conn, args.path), ensure_ascii=False,
                             indent=2, default=json_default))
        elif args.command in MAPPING_PASSES:
            run_mapping_pass(conn, MAPPING_PASSES[args.command][0], args)
        elif args.command == 'activity-state':
            from data_pipeline.activity_state import summary
            migrate(conn)
            print(json.dumps(summary(conn, args.ontology_version),
                             ensure_ascii=False, indent=2, default=json_default))
        elif args.command in ('panel-import', 'panel-refresh', 'official-import', 'panel-lookup-import'):
            from data_pipeline import panel
            from data_pipeline.pipeline import digest
            migrate(conn)
            if args.command == 'official-import':
                registry = json.loads(args.registry.read_text(encoding='utf-8'))
                source = f"{args.registry.name}@{digest(registry)[:12]}"
                with conn.transaction():
                    result = {'imported': panel.import_official(conn, registry, source)}
            elif args.command == 'panel-lookup-import':
                doc = json.loads(args.run.read_text(encoding='utf-8'))
                with conn.transaction():
                    result = {'lookup': panel.record_lookup(conn, doc)}
            elif args.command == 'panel-import':
                doc = json.loads(args.draft.read_text(encoding='utf-8'))
                with conn.transaction():
                    result = {'imported': panel.import_draft(conn, doc, args.draft.name)}
            else:
                result = {}
            with conn.transaction():
                changed = panel.refresh(conn)
            states = conn.execute("""SELECT excluded, panel_state, count(*) AS n
                                       FROM public.source_accounts GROUP BY 1, 2 ORDER BY 1, 2""").fetchall()
            result.update({'changed': len(changed), 'by_state': states})
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'relations-backfill':
            # The crawler is a local-only component (local/x-crawler, ignored by Git).
            crawler_home = ROOT / 'local/x-crawler'
            if not (crawler_home / 'crawler').is_dir():
                raise SystemExit('relations-backfill needs the local crawler at local/x-crawler/crawler')
            sys.path.insert(0, str(crawler_home))
            from crawler.core.errors import SchemaChanged
            from crawler.x import parse as crawler_parse
            from data_pipeline.collection_store import backfill_relations

            def parse_page(data):
                # A page the crawler no longer recognises is skipped like any unparsable page.
                try:
                    return crawler_parse.parse_user_timeline_page(data)
                except SchemaChanged as exc:
                    raise ValueError(str(exc)) from exc
            migrate(conn)
            result = {}
            for run in args.runs:
                with conn.transaction():
                    result[run.name] = backfill_relations(conn, run, parse_page)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        elif args.command == 'post-events':
            from data_pipeline.post_events import rebuild
            migrate(conn)
            print(json.dumps(rebuild(conn), ensure_ascii=False, indent=2))
        elif args.command == 'verify':
            from data_pipeline import verification
            migrate(conn)
            if args.plan_only:
                picked = verification.triggers(conn)
                result = {'triggered': len(picked), 'events': [
                    {'event_id': e, 'title': rs[0]['title'], 'subject_key': rs[0]['subject_key'],
                     'held_down_readings': len(rs)} for e, rs in picked]}
            else:
                result = verification.run(conn, limit_events=args.limit_events)
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'identify-models':
            from data_pipeline import model_identification
            migrate(conn)
            if args.reconcile:
                with conn.transaction():
                    result = model_identification.reconcile(conn)
                model_identification.confirm(conn)
            elif args.report:
                result = model_identification.report(conn)
            else:
                result = model_identification.run(conn, batch_size=args.batch_size, limit=args.limit,
                                                  progress=lambda line: print(line, file=sys.stderr))
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'model-catalog':
            from data_pipeline import model_catalog
            migrate(conn)
            print(json.dumps(model_catalog.run(conn, args.snapshot), ensure_ascii=False, indent=2,
                             default=json_default))
        elif args.command == 'migrate':
            print(json.dumps({'applied':migrate(conn)}))
        elif args.command == 'ingest':
            from data_pipeline.collection_store import ingest_run
            migrate(conn)
            result = ingest_run(conn, args.run)
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'seed-ontology-data':
            from data_pipeline.type_layer import seed
            migrate(conn)
            result = seed(conn, args.ontology_version)
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'gate-state':
            from data_pipeline.gate_state import compute as gate_compute
            migrate(conn)
            result = gate_compute(conn, vocabulary=args.vocabulary)
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'publish-snapshot':
            from data_pipeline.publish import write as write_snapshot
            migrate(conn)
            result = write_snapshot(conn, args.ontology_version)
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))
        elif args.command == 'extract-events':
            run_event_extraction(conn, args)
        elif args.command == 'mine-topics':
            from data_pipeline import deepseek, topic_mining
            deepseek.load_env(ROOT)
            if args.output.exists():
                raise ValueError(f'Output already exists (mining runs are immutable): {args.output}')
            migrate(conn)
            claims = json.loads(args.claims_from.read_text())['claims'] if args.claims_from else None
            run, topics = topic_mining.mine(
                conn, {'start': args.window_start, 'end': args.window_end}, args.output.stem, claims=claims,
                workers=args.workers, limit=args.limit, keep=not args.no_store,
                collection_runs=args.collection_run,
                progress=lambda done, total, what='batch': print(f'  {what} {done}/{total}', flush=True))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            save(args.output, {**run, 'run_id': args.output.stem, 'stored': not args.no_store, 'topics': topics})
            print(json.dumps({**run['counts'], 'stored': not args.no_store, 'output': str(args.output)},
                             ensure_ascii=False, indent=2))
        elif args.command == 'topic-queries':
            from data_pipeline import topic_mining
            migrate(conn)
            pulled = args.votes or max((ROOT / 'data' / 'votes').glob('votes-*.json'), default=None)
            votes = json.loads(pulled.read_text()) if pulled else None
            rows = topic_mining.search_plan(conn, limit=args.limit, per_topic=args.per_topic, votes=votes)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(''.join(query + '\n' for query in dict.fromkeys(row['query'] for row in rows)))
            print(json.dumps({'topics': len({row['topic'] for row in rows}),
                              'queries': len({row['query'] for row in rows}),
                              'topics_readers_voted_on': len({row['topic'] for row in rows if row['votes']}),
                              'votes_file': pulled.name if pulled else None, 'output': str(args.output)}))
        elif args.command == 'topic-searched':
            from data_pipeline import topic_mining
            migrate(conn)
            run_doc = json.loads(args.run.read_text())
            print(json.dumps({'run_id': args.run.stem,
                              'searches_recorded': topic_mining.record_searches(conn, run_doc, args.run.stem)}))
        elif args.command == 'topic-reword':
            from data_pipeline import deepseek, topic_mining
            deepseek.load_env(ROOT)
            migrate(conn)
            print(json.dumps(topic_mining.reword(conn, reason=args.reason,
                                                 progress=lambda done, total, what: print(f'  {what} {done}/{total}', flush=True))))
        elif args.command == 'topic-evidence':
            from data_pipeline import deepseek, topic_evidence
            deepseek.load_env(ROOT)
            migrate(conn)
            print(json.dumps(topic_evidence.run(conn, since=args.since, limit=args.limit, note=args.note,
                                                progress=lambda line: print(line, flush=True)), ensure_ascii=False))
        elif args.command == 'measure-markets':
            from data_pipeline import deepseek, market_measures
            deepseek.load_env(ROOT)
            migrate(conn)
            print(json.dumps(market_measures.link(
                conn, progress=lambda done, total: print(f'  measurement {done}/{total}', flush=True)), ensure_ascii=False))
        elif args.command == 'search-index':
            from data_pipeline import search_index
            from data_pipeline import topic_mining
            topics = [topic_mining.describe(topic) for topic in topic_mining.load_topics(conn)]
            print(json.dumps(search_index.fill_all(conn, [t for t in topics if t['status'] != 'fails'], only=args.only),
                             ensure_ascii=False))
        elif args.command == 'search':
            from data_pipeline import search_index
            for hit in search_index.search(args.index, args.query, limit=args.limit, semantic=args.semantic):
                print(f"{hit['_rankingScore']:.3f}  {hit['title']}  |  {hit.get('title_zh') or hit.get('day') or ''}  [{hit['key']}]")
        elif args.command == 'ingest-events':
            from data_pipeline.event_extraction import ingest_extraction
            migrate(conn)
            result = ingest_extraction(conn, args.archive)
            print(json.dumps(result, ensure_ascii=False, indent=2, default=json_default))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(f'Local data pipeline: {error}', file=sys.stderr)
        sys.exit(1)
