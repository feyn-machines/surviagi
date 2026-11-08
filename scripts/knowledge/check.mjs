#!/usr/bin/env node
// Trusted website code only. Never import or execute code from a content repository.
import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/lib/knowledge/contract.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { validateKnowledgeBundle } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

function readBundle(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('expected a regular JSON bundle of at most 16 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function main(args) {
  if (args.length !== 1 && args.length !== 3 || args.length === 3 && args[1] !== '--previous') {
    console.error('Usage: pnpm knowledge:check BUNDLE.json [--previous ACCEPTED.json]');
    return 2;
  }
  try {
    const errors = validateKnowledgeBundle(readBundle(args[0]), args[2] ? readBundle(args[2]) : undefined);
    if (errors.length) { console.error(errors.join('\n')); return 1; }
    console.log(`Knowledge contract valid${args[2] ? '; append-only history verified' : '; initial publication only (no history baseline)'}.`);
    return 0;
  } catch {
    // Do not echo source JSON or JSON parser excerpts into logs.
    console.error('Cannot validate knowledge: unreadable, nonregular, oversized or invalid JSON input.');
    return 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
