# PR Lens

A private, local review layer for GitHub pull requests. Paste a PR link, PR Lens fetches it
through your own `gh`, runs one read-only pass through your own `claude` CLI, and overlays a
few ranked attention points on a GitHub-style diff. Notes stay on your machine.

Status: **phase 6**: all planned phases (review, anchoring and chunking, cache, compare,
Ask Claude, promote to comment). See [ARCHITECTURE.md](ARCHITECTURE.md) for how it is put together
and what is not built.

## Requirements

- macOS (Linux should work; not tested yet)
- Node.js 20+ and [pnpm](https://pnpm.io) 10+
- [GitHub CLI](https://cli.github.com) (`gh`)
- [Claude Code](https://code.claude.com) (`claude`)
- `git`, for repository-aware reviews, **Ask Claude** worktrees and direct (two-dot) compares of diverged refs. macOS ships it with the Command
  Line Tools (`xcode-select --install`); `brew install git` works too. No Xcode needed.
- Optional, for the **Impact** map of Go or Python changes: your own `gopls` or
  `pyright-langserver` / `basedpyright-langserver`, with its path set in Settings. TypeScript and
  JavaScript need nothing extra. Terraform is also mapped built in without reading remote-state
  backends or other repositories. GitHub Actions workflows and internal actions are built in too.
  Their Impact map links local `uses:` references, including reusable workflows and composite
  actions. Each workflow or action is shown as a whole file; external actions are omitted.

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

Before a new review, PR Lens fetches the head into one shallow, blobless cache repository per
GitHub repository and creates a detached worktree. Review passes can read and search that snapshot
to check callers, contracts and tests, but have no shell or write tools. The worktree is reused by
later review passes and **Ask Claude**; only the 10 most recently used worktrees are retained.

If the header shows a service issue, open **Settings**:
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

**Ask Claude** (on any note, or `a`): PR Lens checks out the PR head in a detached worktree
(shallow, cached, the 10 most recent kept), writes the note, description and the file's diff to
a context file, and opens your terminal (Terminal by default; set another app such as iTerm in
Settings) with an interactive `claude` in that worktree. The session starts in plan mode
(read and explain, no edits), loads only your user settings (the PR's own `.claude/` hooks and
`.mcp.json` never run) and uses your normal `claude` login. The first message is passed as the
session's opening prompt; PR Lens never types into the session. macOS only for now.

**Inbox** is home. It shows your open PRs and PRs GitHub has asked you—or a team you belong to—to
review. Select one to open it. If an organization requires SAML OAuth authorization, the
accessible Inbox data still loads and the unavailable source is identified.

**Promote to comment** (off by default; turn it on in Settings): adds a note to **your pending
review** on the PR through your `gh` login. You see and can edit the exact comment, line and
account in a dialog first. The review header also has **Approve**, **Comment**, and **Request
changes** actions: their dialog submits the whole pending GitHub review, including every staged
comment. Private notes stay only in PR Lens. Your `gh` token needs the `repo` scope
(`gh auth refresh -s repo`); Settings shows whether it has it.

Keyboard: `j` / `k` next and previous note, `s` mark seen, `d` dismiss, `a` ask Claude, and inside a diff
`↑` / `↓` to move between lines and `Enter` to add a private note.

## Build

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm build` writes the bundles to `out/`; `pnpm start` runs that build. To package an unsigned
Apple Silicon app locally, run `pnpm package:mac`; it writes `release/mac-arm64/PR Lens.app`.
GitHub Actions also builds that `.app` on pull requests and `main`, then uploads it as a workflow
artifact. Signing and notarization are not configured yet, so macOS may require an explicit
approval before opening the downloaded app.

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

Deep-dive worktrees have one too (real `gh` and `git`, no terminal, no `claude`):

```bash
PR_LENS_LIVE=1 pnpm test deepdive.live
```

In `pnpm dev`, `PR_LENS_CHUNK_BUDGET=30000` does the same for the app (ignored in packaged builds).

## What leaves your machine

- `gh` calls to GitHub, with your `gh` login. Read-only unless you turn on Promote to comment:
  `gh pr view`, `gh pr diff`, `gh issue view`, and `gh api` for Inbox, compares, commits and ref search.
- Reviews and direct compares fetch only the required commits with `git` (depth 1, no tags, blobless
  until a checkout or diff needs file contents) into one cache per repository, authenticated
  through `gh`. Detached head worktrees are reused across review passes and **Ask Claude**.
- One `claude -p` call per review with the PR title, description, linked issues and the diff of
  non-noise files. PRs over about 90k input tokens are split into up to 8 chunks, reviewed two
  at a time, plus one merge call over the resulting notes. Review passes may read and search the
  detached head snapshot; they have no shell or write tools. A release summary is one more call
  with the commit subjects, the file list and the review's note titles (no diff). Likely secrets are masked first and listed in the sidebar. The call runs with
  no MCP servers, no repository settings files and an allow-listed environment
  (`ANTHROPIC_API_KEY` and GitHub tokens are never passed).

Reviews, private notes and seen/dismissed state are stored as JSON under the app's user-data
directory (`~/Library/Application Support/pr-lens/`). A review is cached per head SHA (per base and head
SHA for a compare): opening
the same PR again, even after a restart, shows it without calling `claude` (the sidebar says
"cached …"). **Re-run review** always runs a fresh pass; a new push to the PR gets a new review.
