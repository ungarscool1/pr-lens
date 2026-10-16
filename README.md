# PR Lens

A private, local review layer for GitHub pull requests. Paste a PR link, PR Lens fetches it
through your own `gh`, runs one read-only pass through your own `claude` CLI, and overlays a
few ranked attention points on a GitHub-style diff. Notes stay on your machine.

Status: **phase 3** (MVP, line-ID anchoring, chunked reviews of big PRs, and an on-disk
review cache). See [ARCHITECTURE.md](ARCHITECTURE.md) for how it is put together
and what later phases add.

## Requirements

- macOS (Linux should work; not tested yet)
- Node.js 20+ and [pnpm](https://pnpm.io) 10+
- [GitHub CLI](https://cli.github.com) (`gh`)
- [Claude Code](https://code.claude.com) (`claude`)
- `git`, only for direct (two-dot) compares of diverged refs. macOS ships it with the Command
  Line Tools (`xcode-select --install`); `brew install git` works too. No Xcode needed.

## Setup

```bash
pnpm install
```

Log in to both CLIs once, in a terminal. PR Lens reuses these logins and never sees the tokens.

```bash
gh auth login
```

```bash
claude
```

(`claude` asks you to log in on first start; quit it once you are in.)

Optional: instead of the interactive login, run `claude setup-token` and paste the token in
**Settings → Claude OAuth token**. It is encrypted with the system keychain (Electron
`safeStorage`) and only handed to the `claude` process.

## Run

```bash
pnpm dev
```

Paste a PR link (`https://github.com/owner/repo/pull/123`) or `owner/repo#123` into the field at
the top and press Enter. PRs under the auto-run budget (60k input tokens by default) are
reviewed straight away; bigger ones wait for **Run review**.

If the header shows `not found` or `not logged in`, open **Settings** (click the status chips):
the health check says what is missing, and you can point PR Lens at `gh` / `claude` explicitly.
GUI apps on macOS do not inherit your shell `PATH`; PR Lens asks your login shell for it and
falls back to `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and `~/.claude/local`.

**Compare** (tab at the top): pick a repository, a base and a head (branch, tag or SHA; the
fields suggest branches and tags as you type) and a diff mode:

- **Merge base (three-dot)**: what head adds since it forked from base. Same as GitHub.
- **Direct (two-dot)**: base tree to head tree, including changes on base that head lacks.
  When base is an ancestor of head the two are identical, and the label says so.

The same review, notes and cache work on compare ranges. When base and head are both tags,
**Write release summary** groups what changed by area and, if the review ran, points at the
notes to look at first.

Keyboard: `j` / `k` next and previous note, `s` mark seen, `d` dismiss, and inside a diff
`↑` / `↓` to move between lines and `Enter` to add a private note.

## Build

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm build` writes the bundles to `out/`; `pnpm start` runs that build. Packaging into a
signed `.app` is not set up yet.

## Develop

```bash
pnpm test
```

```bash
pnpm lint
```

```bash
pnpm typecheck
```

`pnpm format` runs Prettier. Tests cover the pure logic (diff parsing, line IDs, noise globs,
chunk planning, note validation and repair, merge and ranking, secret redaction, CLI envelope
parsing, binary resolution) and the review pipeline against a fake `claude`.

A live smoke test runs the real pipeline (`gh` + `claude`, no window) and costs real tokens,
so it is skipped unless asked for. `PR_LENS_LIVE_BUDGET` lowers the chunk budget to force
chunking on a mid-size PR:

```bash
PR_LENS_LIVE=1 PR_LENS_LIVE_PR='cli/cli#14104' PR_LENS_LIVE_BUDGET=30000 pnpm test pipeline.live
```

The compare path (real `gh` and `git`, no `claude`, no tokens) has its own live test:

```bash
PR_LENS_LIVE=1 pnpm test compare.live
```

In `pnpm dev`, `PR_LENS_CHUNK_BUDGET=30000` does the same for the app (ignored in packaged builds).

## What leaves your machine

- `gh` calls to GitHub, with your `gh` login. Read-only: `gh pr view`, `gh pr diff`, `gh issue view`,
  and `gh api` for compares, commits and ref search.
- Direct compares of diverged refs fetch just the two commits with `git` (shallow, file
  contents on demand) into the user-data directory, authenticated through `gh`.
- One `claude -p` call per review with the PR title, description, linked issues and the diff of
  non-noise files. PRs over about 90k input tokens are split into up to 8 chunks, reviewed two
  at a time, plus one merge call over the resulting notes. A release summary is one more call
  with the commit subjects, the file list and the review's note titles (no diff). Likely secrets are masked first and listed in the sidebar. The call runs with
  no tools, no MCP servers, no settings files and an allow-listed environment
  (`ANTHROPIC_API_KEY` and GitHub tokens are never passed).

Reviews, private notes and seen/dismissed state are stored as JSON under the app's user-data
directory (`~/Library/Application Support/pr-lens/`). A review is cached per head SHA (per base and head
SHA for a compare): opening
the same PR again, even after a restart, shows it without calling `claude` (the sidebar says
"cached …"). **Re-run review** always runs a fresh pass; a new push to the PR gets a new review.
