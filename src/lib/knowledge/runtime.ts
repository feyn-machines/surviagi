import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseKnowledgeJson, type KnowledgeArtifact } from './importer';
import { createKnowledgeReader, fileBaseline } from './reader';
import { createKnowledgeAgent } from './agent';

type Reader = ReturnType<typeof createKnowledgeReader>;
let verified: { identity: string; reader: Reader } | undefined;

/** Local imported artifact only. This loader never fetches or activates a knowledge version. */
export async function loadKnowledgeReader() {
  const path = process.env.KNOWLEDGE_ARTIFACT_PATH ?? 'data/knowledge/current.json';
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(32 * 1024 * 1024)) throw new Error('Invalid knowledge artifact file');
    const baselinePath = process.env.KNOWLEDGE_WITHDRAWALS_PATH;
    const fingerprint = (s: typeof stat) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
    const identity = JSON.stringify([path, baselinePath ?? null, fingerprint(stat)]);
    if (verified?.identity === identity) return verified.reader;
    const bytes = await file.readFile();
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Knowledge artifact oversized');
    if (fingerprint(await file.stat({ bigint: true })) !== fingerprint(stat)) throw new Error('Knowledge artifact changed while reading');
    // Concurrent first readers can reuse the validation completed while their I/O was pending.
    if (verified?.identity === identity) return verified.reader;
    const reader = createKnowledgeReader(parseKnowledgeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as KnowledgeArtifact,
      fileBaseline(baselinePath));
    // Cache only the immutable verified index, never filtered responses. Each reader call reloads the baseline.
    verified = { identity, reader };
    return reader;
  } finally { await file.close(); }
}
export const knowledgeAgent = createKnowledgeAgent(loadKnowledgeReader);
