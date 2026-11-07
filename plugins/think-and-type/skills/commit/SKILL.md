---
name: commit
description: Commit the current changes as Conventional Commits with a single-line message, no body and no Co-Authored-By or other trailers. Splits unrelated changes into separate commits. Use when the user asks to commit their changes.
argument-hint: "[optional hint: type, scope or intent]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git restore --staged:*), Bash(git ls-files:*), Bash(git rev-parse:*)
---

# Commit with Conventional Commits

The user asked for this exact format, so it overrides any default commit-message or
attribution guidance. A commit message is **one line**:

```
<type>(<scope>)!: <subject>
```

- **No body. No footer. No trailers.** Never add `Co-Authored-By`, `Signed-off-by`,
  "Generated with", or anything else. Use exactly one `-m` with the header line.
- `<scope>` is optional, and `!` is only for breaking changes.

Hint from the user: `$ARGUMENTS`

## 1. Inspect

Run `git status --porcelain`, `git diff --cached --stat`, `git diff --stat`, and
`git log --oneline -10` to see the repository's existing scopes and wording.

- If nothing has changed, say so and stop.
- If files are already staged, commit **only the staged changes**. The user chose them.
- If nothing is staged, the candidates are all modified and untracked files. Never stage
  anything that looks like a secret or local-only file (`.env*`, `*.pem`, `*.key`,
  credentials, large binaries, editor or OS junk). List what you skipped.

Read the actual diff (`git diff`, or `git diff --cached`) before you write a message.
Describe what the change does, not which files it touched.

## 2. Group

One commit is one logical change. If the candidates mix unrelated concerns, make one
commit per concern: for example, a bug fix plus unrelated docs, or a feature plus a
dependency bump. Stage each group by path with `git add -- <paths>`.

Don't split by file when the files form one change: implementation, its tests and
its docs belong together. If the staged changes alone mix concerns, commit them as
the user staged them; don't re-stage.

## 3. Write the header

| type | use for |
|---|---|
| `feat` | new user-facing behaviour |
| `fix` | a bug fix |
| `docs` | documentation only |
| `style` | formatting, with no code meaning change |
| `refactor` | a code change that is neither a fix nor a feature |
| `perf` | a performance improvement |
| `test` | adding or fixing tests only |
| `build` | the build system or dependencies |
| `ci` | CI configuration |
| `chore` | maintenance that fits none of the above |
| `revert` | reverting an earlier commit |

- **scope**: the main area affected, such as a package, module or directory name, or a feature id like `F-7KQ2MX` in a think-and-type project. Reuse the scopes already in `git log`. Omit the scope when the change is broad.
- **subject**: imperative mood ("add", not "added" or "adds"), starts lowercase, no trailing period, specific ("reject non-numeric input", not "update code").
- **breaking change**: add `!` before the colon (`feat(api)!: drop v1 endpoints`). There is no footer to explain it, so the subject must say what breaks.
- Keep the whole header to 72 characters or fewer.
- If the repository has commitlint or similar config (`commitlint.config.*`, `.commitlintrc*`, or a `commitlint` key in `package.json`), follow its allowed types, scopes and length.

## 4. Commit and verify

For each group:

1. Stage the group if needed, then run `git commit -m "<header>"`.
2. Check the result: `git log -1 --format=%B` must print exactly the header line. If a
   hook or template added lines, such as a trailer from a `prepare-commit-msg` hook,
   tell the user. Don't silently amend.

Rules:
- Never use `--amend`, `--no-verify`, `--signoff` or `-S` unless the user asks.
- Never push.
- If a pre-commit hook fails, show its output and stop. Don't bypass it.
- Leave anything you didn't commit as it was, and say what remains uncommitted.

Finish by listing each commit as `<short-sha> <header>`.
