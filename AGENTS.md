# AGENTS.md

Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.

## Start

- Repo: `https://github.com/paritytech/dotli`.
- Replies: repo-root refs only: `apps/host/src/main.ts:42`. No absolute paths, no `~/`.
- High-confidence answers only when fixing/triaging: verify source, tests, current behavior before deciding.
- Dependency-backed behavior: read upstream docs/source/types first. Do not assume APIs, defaults, errors, timing, or runtime behavior.
- Live-verify when feasible. After observability changes, query Sentry MCP for the exact field before claiming success.
- Missing deps: `bun install`, retry once, then report first actionable error.
- Wording: product/docs/UI say "dot.li" or "dotli"; `@dotli/*` is the package namespace.
- New `AGENTS.md`: add sibling `CLAUDE.md` symlink.

## Map

- Apps: `apps/host` (host shell), `apps/protocol` (smoldot SharedWorker), `apps/sandbox` (CID app container).
- Packages: `resolver` (read-only dotNS dry-runs), `auth` (HDKD signing), `protocol` (postMessage bridge), `content` (CAR + SW serving), `storage`, `ui`, `metrics` (Sentry; registry in `src/spans.ts`), `shared`, `config`, `sandbox-checker`, `eslint-config`, `typescript-config`.
- Deeper docs: `README.md`, `docs/`, `Makefile`, `.github/workflows/`.

## Architecture

- Two builds, two origins. `name.dot.li` (host shell) iframes `name.app.dot.li` (per-product app, distinct origin) so SW/storage/auth stay isolated. Host resolves dotns to a CID and threads it into the sandbox via the URL contract. When debugging, check which build you're in.
- smoldot in a SharedWorker via `apps/protocol`; chain access only through `packages/protocol` bridge. No direct WebSockets in host or sandbox.
- Multi-file SPAs: SW intercepts under `/dotli-app/`; `packages/content` parses CAR into a file map. SPA breaks in preview but not dev: suspect SW state.
- Metrics registry centralized in `packages/metrics/src/spans.ts`; reuse constants for any tag/attribute/span/breadcrumb. No string literals at call sites.
- Resolver is read-only: `packages/resolver` dry-runs only. Signing belongs in `packages/auth`; do not blur.
- Owner boundary: package-specific behavior fixed in the owning package. Shared/core gets generic seams only when multiple owners need them.
- Config contract: per-env values in `packages/config`; new endpoints/contract addresses go there, not inline.
- Direction: manifest-first config; no hidden bypasses.

## Commands

- Runtime: Bun 1.3.6, Node 22+. TypeScript 6 strict. Vite 8.
- Install: `bun install`; CI uses `--frozen-lockfile`.
- Preview: `bun run preview`. Wildcard `*.localhost:5173`.
- Build: `bun run build`; prod: `bun run build:prod`.
- Typecheck: `bun run typecheck`.
- Lint: `bun run lint`.
- Format: `bun run format` / `bun run format:check`. Prettier 3, `.prettierrc`.
- Test (vitest): `bun run test`; targeted: `bun --filter @dotli/<pkg> run test`.
- E2E (from `apps/host/`): `bun run test:e2e`. Flags: `HEADED=1`, `SLOWMO=2000`, `CHANNEL=chrome`, `--grep "<pattern>"`.
- Perf (from `apps/host/`): `bun run test:perf`; baseline: `bun run test:perf:base`; diff: `bun run test:perf:compare` (`--markdown` for PR output).

## Deploy

- Make targets: `make deploy ENV=<env>`, `make deploy-nginx ENV=<env>`. Envs: `polkadot` (prod), `paseo`/`westend`/`dev-*` (staging). Site/path tables in `Makefile`.
- Pushes to `main` auto-deploy to staging (Paseo); tagged releases deploy to prod.
- Never run `make deploy`; confirm and let user run it.

## GitHub / CI

- Triage: list first, hydrate few. Use bounded `gh --json --jq`.
- PR shortlist: `gh pr list ...`; then `gh pr view <n> --json number,title,body,files,statusCheckRollup,reviewDecision`.
- Never auto-comment, close, label, or merge without explicit user request.
- PR review: `/review-pr <pr>` triggers the `review-pr` skill (`.agents/skills/review-pr/`).
- After landing PR: search duplicate open issues/PRs. Before closing: comment why + canonical link.
- GH comments with markdown backticks, `$`, or shell snippets: avoid inline double-quoted `--body`; use single quotes or `--body-file`.
- PR create: description always required. Concise Summary + Test plan; reference issue/PR refs. Never open an empty-description PR.
- When working on an issue or PR, always end the user-facing final answer with the full GitHub URL.
- CI polling: exact SHA, needed fields only. `gh api repos/paritytech/dotli/actions/runs/<id> --jq '{status,conclusion,head_sha,name}'`.
- CI workflows: `test.yml`, `lint.yml`, `perf.yml`, `bundle-size.yml`, `deploy-stg.yml`, `deploy-prod.yml`, `deploy-dev.yml`, `deploy.yml`, `assign.yml`, `labeler.yml`, `security.yml`, `update-chain-specs.yml`.

## Gates

- Before push: `bun run typecheck`, `bun run lint`, `bun run format:check` clean.
- Touched `apps/host` source: also `bun run test:e2e`.
- Touched `packages/metrics/src/spans.ts`: verify call sites consume the new key.
- Touched `apps/host` resolution code: run `tests/resolution.spec.ts` before push.
- Observability changes: query Sentry MCP for the exact field after deploy. Do not declare success from chat alone.
- Do not skip git hooks (`--no-verify`) or bypass signing without explicit user approval. If a hook fails, fix the cause.
- Hard build gate: `bun run build` before push if Vite config, lazy boundaries, or worker entry points changed.

## Code

- TS ESM, strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- No `@ts-nocheck`. Lint suppressions only intentional + explained.
- External boundaries (postMessage payloads, network responses, IndexedDB reads): prefer `zod` or schema validation.
- Runtime branching: discriminated unions/closed codes over freeform strings.
- Avoid semantic sentinels: `?? 0`, empty object/string, etc.
- Comments: brief, only non-obvious logic. No em-dashes or semicolons.
- Docs: see `CONTRIBUTING.md` for JSDoc/file-header conventions.
- Naming: `dot.li`/`dotli` product/docs/UI; `@dotli/*` packages.
- English: American spelling.

## Tests

- Vitest. Colocated `*.test.ts`; `happy-dom` (DOM), `fake-indexeddb` (IndexedDB).
- E2E: Playwright in `apps/host/tests/{loading,resolution,navigation}.spec.ts` (preview-server-backed) and `apps/host/e2e/tests/host-playground.spec.ts` (WebHost product flows).
- Before writing or modifying E2E tests, read `CONTRIBUTING.md` `### How to Test` for user-story naming and the Given/When/Then convention.
- Perf: `apps/host/tests/cold-start.spec.ts`; compare via `tests/compare.ts`.
- Targeted: `bun --filter @dotli/<pkg> run test`. From `apps/host/`: `bunx playwright test tests/<file>.spec.ts --grep "<pattern>"`.
- Avoid brittle tests that grep workflow/docs strings. Prefer behavior assertions.
- Clean timers/env/globals/mocks/IndexedDB/SW/temp dirs/module state.
- Do not run multiple Vitest invocations concurrently in the same worktree; cache races on `node_modules/.vite`.
- Live-prove the reported issue before landing when feasible. `bun run preview` plus a fresh Chrome profile reproduces cold-cache scenarios.
- `apps/host/tests/results.json` is a local artifact; do not commit.

## Git

- Commits: `type(scope): message`, conventional, single-line, lowercase after colon, no period. Types: `feat`, `fix`, `chore`, `docs`, `refactor`.
- Branches: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `refactor/<slug>`.
- PRs against `main`. CI runs lint, tests, E2E, bundle-size, perf. Reviewers auto-assigned by `.github/workflows/assign.yml`.
- `main`: rebase before push; no merge commits.
- User says `commit`: your changes only. `commit all`: all changes in grouped chunks. `push`: may `git pull --rebase` first.
- Do not skip hooks (`--no-verify`) or bypass signing without explicit user approval.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >5: ask with count/scope.

## Security / Release

- Never commit private keys, SSH credentials, deploy keys, or `.env*` files.
- Deploy SSH targets in `Makefile` (`REMOTE_PRD`, `REMOTE_STG`).
- Releases/tags need explicit user approval; tagged commits auto-deploy to prod.
- Dependency upgrades touching `bun.lock` need scrutiny.
- Contract addresses live in `packages/config`; per-env values, not inlined.

## MCP

`.mcp.json` wires:

- `sentry`: traces, errors, spans for dot.li projects.
- `polkadot-docs`: Polkadot/Substrate/Asset Hub/Revive docs.
- `chrome-devtools`, `firefox-devtools`: browser drivers.

## Ops / Footguns

- `.gitignore` excludes vendor AI sprawl: `.cursor`, `.codeium`, `.gemini`, `.roo`, `.cline`, `.claude-flow`, `.codex`, `.swarm`, `.ai`, `.llm`, `opencode.json`, `GEMINI.md`.
- `.claude/settings.local.json` and `.claude/worktrees/` stay local.
- `bun.lock` committed; do not regenerate casually.
- Never edit `node_modules` or `.turbo` cache.
- Wildcard subdomains: COOP/COEP headers in `scripts/preview-server.ts`.
- SW state persists across reloads. SPA works in dev but not preview: clear SW in DevTools first.
- Smoldot bootstrap slow on cold start; perf tests warm via SharedWorker in `apps/protocol`.
- Local-only ignores: `.git/info/exclude`, not repo `.gitignore`.
