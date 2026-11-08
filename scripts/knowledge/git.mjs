import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KNOWLEDGE_REMOTE = 'https://github.com/feyn-machines/surviagi-knowledge.git';
const cleanGitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const shaPattern = /^[a-f0-9]{40}$/;
/** Reads blobs without checkout, hooks, submodules, filters, includes or content executables. */
export function readGitFiles(repository, commit) {
  if (!shaPattern.test(commit)) throw new Error('Expected full commit SHA');
  const git = (...args) => decode(execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], { maxBuffer: 18 * 1024 * 1024, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv() }));
  if (git('rev-parse', `${commit}^{commit}`).trim() !== commit) throw new Error('Git commit mismatch');
  const entries = git('ls-tree', '-rz', '--full-tree', commit).split('\0').filter(Boolean);
  if (entries.length > 100000) throw new Error('Repository tree oversized');
  const files = []; let total = 0;
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid Git tree');
    const [, mode, type, oid, path] = match;
    // Working documents and scripts outside the formal tree are ignored, never executed.
    if (!/^(questions|cases|answers|updates)(\/|$)/.test(path) && path !== 'withdrawals.json') continue;
    if (type !== 'blob' || mode !== '100644') throw new Error('Nonregular formal object');
    const size = Number(git('cat-file', '-s', oid).trim()); total += size;
    if (!Number.isSafeInteger(size) || size > 1024 * 1024 || total > 16 * 1024 * 1024 || files.length >= 10000) throw new Error('Knowledge blob budget exceeded');
    files.push({ mode, path, data: git('cat-file', 'blob', oid) });
  }
  return files;
}
export async function fetchKnowledgeFiles(commit) {
  if (!shaPattern.test(commit)) throw new Error('Expected full commit SHA');
  const dir = mkdtempSync(join(tmpdir(), 'surviagi-knowledge-'));
  const run = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv() });
  try {
    run(['init', '--bare', dir]);
    try {
      run(['-C', dir, '-c', 'protocol.file.allow=never', 'fetch', '--no-tags', '--depth=1', KNOWLEDGE_REMOTE, commit]);
    } catch {
      const error = new Error('Knowledge source unavailable'); error.code = 'KNOWLEDGE_SOURCE_UNAVAILABLE'; throw error;
    }
    return readGitFiles(dir, commit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
