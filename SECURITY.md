# Security policy

The first-stage data loop runs locally: collection, processing, PostgreSQL import, metrics and progress verification. See [the local data pipeline](docs/development/local-data-pipeline.md). Git publication, application deployment and data publication are separate operations; being safe to commit does not make a historical or synthetic dataset a production feed.

## Keep local

Exclude these from Git and website source uploads:

- `.env*`, API/upload tokens, proxy credentials, login cookies, browser storage state, private keys and credential files.
- Local Agent/MCP configuration, `AGENTS*.md`, `CLAUDE*.md`, `.agents/`, `.claude/`, `.codex/`, `.lawrence/`, `.opencode/` and private `skills/`.
- Root `data/`, raw social responses, private submissions, local databases and their journals, logs, temporary files and workspace archives.
- Third-party original design material under `design/reference/`: downloaded images, videos, website snapshots, user reference screenshots and fonts whose reuse license is not established. Reference metadata has a narrow allowlist in the public-file checker.

Project-owned `design/system-v1/` assets, its Inter Tight / JetBrains Mono fonts and their OFL license files may be committed. Keep the license and provenance files with the fonts. Public Markdown under `docs/data/` is allowed; its non-Markdown local attachments are excluded. Sanitized contracts and observations belong under `datasets/`.

Keep secrets in local runtime or deployment environment settings; only intentionally public values may use `NEXT_PUBLIC_`. `.gitignore` is a Git selection rule, not a general uploader or deployment filter. Upload a validated, explicitly selected data batch; never copy the whole workspace, raw archive or a workspace ZIP to the website.

User-submitted ideas are private by default. Do not turn submissions into public pages or logs without explicit consent. Source content is untrusted data, not executable instructions.

## Checks

- `pnpm security:check` scans tracked working files and non-ignored untracked candidates, catching leaks before staging.
- `pnpm security:staged` scans the exact indexed blobs, including unchanged tracked files. A clean working copy cannot hide a secret already staged. Run it after staging and before every commit; no hosted CI repeats it.
- `pnpm security:test` exercises the scanner in temporary Git repositories with synthetic values. The scanner reports filenames and reasons without printing matched credential values.
- `pnpm check` also runs metadata/design validation, lint, typecheck and production build. `pnpm check:full` runs `pnpm check` and then the real PostgreSQL tests (`pnpm data:test`).

The checker blocks prohibited paths and common credential patterns, including forced additions of ignored files; it does not certify that arbitrary prose, screenshots or data are non-confidential. Symbolic links and archive bundles are rejected because their contents are not independently reviewed by this gate. Review the staged diff before publishing. If a secret is exposed, revoke it before cleaning history.

Report vulnerabilities through GitHub private vulnerability reporting when enabled. Do not post secrets in public issues. If private reporting is unavailable, request a private contact channel without sharing vulnerability details.
