#!/usr/bin/env node
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importer } from './load.mjs';
import { fetchKnowledgeFiles } from './git.mjs';
function read(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 32 * 1024 * 1024) throw new Error('Invalid artifact file');
  return importer.parseKnowledgeJson(readFileSync(path, 'utf8'));
}
export async function main(args) {
  const allowed = new Set(['--commit', '--website-commit', '--output', '--cache', '--cache-index', '--previous']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || options[args[i]]) return 2;
    options[args[i]] = args[i + 1];
  }
  if (!options['--commit'] || !options['--website-commit'] || !options['--output']) {
    console.error('Usage: pnpm knowledge:import --commit SHA --website-commit SHA --output CANDIDATE.json [--cache VERIFIED.json --cache-index TRUSTED_HASH] [--previous ACCEPTED.json]');
    return 2;
  }
  let temporary;
  try {
    const output = resolve(options['--output']);
    // Never replace accepted history or the cache on a failed import (or a successful one).
    const actualPath = p => existsSync(p) ? realpathSync(p) : resolve(realpathSync(dirname(p)), basename(p));
    if ([options['--previous'], options['--cache']].filter(Boolean).some(p => actualPath(resolve(p)) === actualPath(output))) throw new Error('Candidate must be separate');
    let cacheUsed = false;
    const artifact = await importer.importWithCache({ commit: options['--commit'], websiteCommit: options['--website-commit'], previous: options['--previous'] ? read(options['--previous']) : undefined, cache: options['--cache'] ? () => read(options['--cache']) : undefined, cacheIndexHash: options['--cache-index'], onCacheUsed: () => { cacheUsed = true; }, fetchFiles: () => fetchKnowledgeFiles(options['--commit']) });
    temporary = `${output}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(artifact) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, output); temporary = undefined;
    console.log(`Knowledge candidate ${artifact.commit}, index ${artifact.indexHash}; not activated; ${cacheUsed ? `verified cache ${options['--cache-index']}` : 'fetched source'}; ${options['--previous'] ? 'append-only history checked' : 'initial publication only'}.`);
    return 0;
  } catch {
    console.error('Knowledge import failed: source/cache, path, integrity or history validation. No candidate activated.');
    return 1;
  } finally { if (temporary) { try { unlinkSync(temporary); } catch { /* preserve original failure */ } } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
