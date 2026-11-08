import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseKnowledgeJson, type KnowledgeArtifact } from './importer';
import { createKnowledgeReader, fileBaseline } from './reader';
import { createKnowledgeAgent } from './agent';

/** Local imported artifact only. This loader never fetches or activates a knowledge version. */
export async function loadKnowledgeReader() {
  const path = process.env.KNOWLEDGE_ARTIFACT_PATH ?? 'data/knowledge/current.json';
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid knowledge artifact file');
    const bytes = await file.readFile();
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Knowledge artifact oversized');
    // Verify the complete artifact on every request; do not cache previously filtered bodies.
    return createKnowledgeReader(parseKnowledgeJson(bytes.toString('utf8')) as KnowledgeArtifact,
      fileBaseline(process.env.KNOWLEDGE_WITHDRAWALS_PATH));
  } finally { await file.close(); }
}
export const knowledgeAgent = createKnowledgeAgent(loadKnowledgeReader);
