# Local editorial prepublication

The editorial publisher writes only to the loopback PostgreSQL database `openaiwill_local`; it does not accept a server URL. Keep its manifest, bilingual Markdown and evidence report under the ignored `data/editorial/` directory. Use directory mode `0700` and file mode `0600`.

## Prepare a package

The manifest is JSON and records the exact versions expected before the write, source cutoff, gates, SHA-256 of both complete Markdown files, and a hash-pinned private evidence report. Each Markdown file has `title`, `description`, and `date` frontmatter. Both languages must have the same non-empty set of HTTPS source links. `excludedClaims` is a list of literal strings that must not occur in either article body; use it for claims held out at preflight.

Example shape (hashes are placeholders):

```json
{
  "articleId": "example-article",
  "sourceCutoff": "2026-10-28T00:00:00Z",
  "createdBy": "editorial-run:0123456789abcdef01234567",
  "evidenceGate": "pass",
  "bilingualGate": "pass",
  "expected": { "previewVersion": null, "approvedVersion": null },
  "evidenceReport": { "path": "evidence.md", "sha256": "<64 lowercase hex characters>" },
  "excludedClaims": [],
  "languages": {
    "en": { "path": "en.md", "sha256": "<64 lowercase hex characters>" },
    "zh-CN": { "path": "zh-CN.md", "sha256": "<64 lowercase hex characters>" }
  }
}
```

After the 045 local database migration exists, run:

```sh
pnpm data:migrate
pnpm editorial:publish --manifest data/editorial/<package>/manifest.json --confirm-public-preview
```

The command refuses stale package hashes, failed gates, missing languages, mismatched source links, held claim strings present in the article, symlinks, public file permissions, and changed publication pointers. It writes both localizations and advances only `preview_version` in one transaction. Repeating an identical package is idempotent. A newer preview leaves the approved pointer unchanged.

`--confirm-public-preview` is required because a preprint is reader-visible and is not an approval. This command targets the developer's loopback database only; it does not publish the article to surviagi.com. No credential is written into `.env` or printed. To inspect local preview routes, `pnpm editorial:dev` starts Next.js with the private local connection in process memory; preview pages remain outside the regular article list.

The evidence and bilingual gate values are recorded editorial decisions, not a semantic fact checker. The publishing command verifies the package's hashes and structural constraints; it cannot independently establish that a source proves a claim.
