---
name: review-pr
description: Read-only review of a GitHub pull request. Use when asked to review a PR, look at a PR, or assess readiness to land. Never push, merge, or modify code intended to keep.
---

# Review PR

## Overview

Read-only review producing a structured report.

## Inputs

- Ask for PR number or URL.
- If missing, always ask.
- If the URL is a different `owner/repo`, pass `--repo <owner>/<repo>` to every `gh` call.

## Safety

- Never push, merge, or modify code intended to keep.
- Work only in `.claude/worktrees/pr-<PR>`.
- Never auto-post the review.

## Steps

1. Setup worktree

```sh
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
gh auth status

WORKTREE_DIR=".claude/worktrees/pr-<PR>"
git fetch origin main

if [ -d "$WORKTREE_DIR" ]; then
  cd "$WORKTREE_DIR"
  git fetch origin main
else
  git worktree add "$WORKTREE_DIR" -b review/pr-<PR> origin/main
  cd "$WORKTREE_DIR"
fi
```

Run all subsequent commands in the worktree.

2. PR metadata

```sh
gh pr view <PR> --json number,title,author,baseRefName,headRefName,headRefOid,state,isDraft,body,files,additions,deletions,labels,reviewDecision,statusCheckRollup
gh pr checks <PR>
```

3. Check main for existing or overlapping work

```sh
rg -n "<keyword_from_title>" -S apps packages || true
git log --oneline --all --grep "<keyword>" | head -20
```

4. Claim PR (best effort)

```sh
gh_user=$(gh api user --jq .login)
gh pr edit <PR> --add-assignee "$gh_user" || echo "Could not assign reviewer, continuing"
```

5. Fetch PR head and merge-base diff

```sh
git fetch origin pull/<PR>/head:pr-<PR>
git checkout pr-<PR>
MERGE_BASE=$(git merge-base origin/main pr-<PR>)
git diff --stat "$MERGE_BASE"..pr-<PR>
gh pr diff <PR>
```

6. Read changed files at PR head against `AGENTS.md` architecture rules.

7. Optional targeted tests

```sh
bun --filter @dotli/<pkg> run test
cd apps/host && bunx playwright test tests/resolution.spec.ts --grep "<relevant>"
```

## Report

Markdown report. Skip empty sections.

- Summary. One sentence. Diff stats. PR URL.
- Blocking. Correctness, security, regression, duplicates of existing main code. Format `path:line` plus one-line description plus suggested fix.
- Should-fix. Quality issues a reviewer would call out.
- Nits. Optional polish.
- Questions. Anything ambiguous to ask the author.
- CI status. Pass/fail summary from `gh pr checks`.

Severity:

- Blocking. Must address before land.
- Should-fix. Author judgment.
- Nit. Author free to ignore.

Tone direct. Do not restate what the PR does. Do not soften criticism with praise. Do not propose a sweeping refactor when a one-line fix works.

End the chat response with the PR URL.

## Guardrails

- Read-only.
- Do not delete the worktree. User may want to re-run checks.
- Merge-base scoped diff to avoid stale main drift.
