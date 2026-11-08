// Transpile only these website-owned modules. Content repositories never supply code.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const urls = {};
for (const name of ['contract', 'importer', 'reader']) {
  let js = ts.transpileModule(readFileSync(new URL(`../../src/lib/knowledge/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [dep, url] of Object.entries(urls)) js = js.replaceAll(`'./${dep}'`, JSON.stringify(url));
  urls[name] = `data:text/javascript,${encodeURIComponent(js)}`;
}
export const importer = await import(urls.importer);
export const reader = await import(urls.reader);
