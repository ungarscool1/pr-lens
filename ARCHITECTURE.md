# Architecture

```
renderer (React, sandboxed)  ──window.prLens──▶  preload (contextBridge)  ──ipcRenderer.invoke──▶  main
        UI only                                  ~1 kB, no logic                                    validates, runs gh / claude
```

## Layers

| Layer    | Path           | Can do                                                  | Cannot do                                    |
| -------- | -------------- | ------------------------------------------------------- | -------------------------------------------- |
| main     | `src/main`     | spawn `gh` / `claude`, read/write userData, safeStorage | —                                            |
| preload  | `src/preload`  | expose a fixed list of IPC methods                      | anything else (sandboxed, type-only imports) |
| renderer | `src/renderer` | render, keyboard, clipboard write                       | fs, processes, tokens, navigation            |
| shared   | `src/shared`   | zod schemas + types used by all three                   | —                                            |

Window: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP (`script-src 'self'`,
no remote origins), navigation and `window.open` blocked, `webview` blocked, permission
requests denied except clipboard write. External links go through `shell.openExternal` only
for `https://` URLs on an allow-list (`src/main/shell/external.ts`).

## IPC

`src/shared/ipc.ts` is the contract: every channel's input schema (zod) and result type. Main
(`src/main/ipc/register.ts`) checks the sender frame, parses every payload, and returns
`{ ok, data } | { ok: false, error: { code, message } }`; the renderer turns failures back into
a typed `AppError` (`src/shared/errors.ts`). There is no generic "run a command" channel: each
handler calls one specific `gh` or `claude` invocation with a fixed argument list.

Review progress is pushed on `review:event`. Every event carries its target key, so the
renderer can match events that arrive before `review:start` has replied.

## Running CLIs

- `src/main/exec/exec.ts` is the only place a process starts: `execFile`, never a shell
  string, with timeout, `AbortSignal` (cancel kills the child), output cap, and typed errors.
- `src/main/exec/resolve-bin.ts` gets `PATH` from the login shell (a constant command, with
  markers so shell banners are ignored), then searches it plus fallback dirs. Settings can
  override either binary.
- `src/main/exec/toolchain.ts` builds the child environments from allow-lists. `claude` gets
  `PATH`, `HOME`, locale vars and, if set, `CLAUDE_CODE_OAUTH_TOKEN`; nothing else.
- `src/main/git/git.ts` is only used for direct (two-dot) compares of diverged refs: GitHub's
  compare API has no two-dot diff. It keeps a bare cache repo per GitHub repo, fetches just the
  two SHAs (`--depth=1 --filter=blob:none`), and `git diff`s them; git fetches the blobs it
  needs on demand. Credentials come from `gh auth git-credential`, never a prompt
  (`GIT_TERMINAL_PROMPT=0`).

## Deep dive (`src/main/deepdive`)

"Ask Claude" on a note:

1. `git.worktree` fetches the head SHA into the bare cache repo and adds a detached worktree
   under `userData/worktrees/<owner>__<repo>__pr<n>__<sha7>` (reused while its HEAD matches;
   least recently used beyond 10 are removed).
2. A session dir under `userData/sessions/` gets `pr.md` (note, description or commits, file
   list, the note's file diff, secrets masked), `first-message.txt` and `launch.command`
   (0700).
3. `open -a <terminal app> launch.command`. The script `cd`s into the worktree, unsets
   `ANTHROPIC_API_KEY` and `exec`s `claude --permission-mode plan --setting-sources user
--strict-mcp-config --add-dir=<session dir> "$(cat first-message.txt)"`. Only paths PR Lens
   chose are interpolated, single-quoted; PR text is read from a file at run time, so it can
   never become shell code (covered by a test that runs the script with a stub `claude`).
   Project settings and MCP config from the checked-out PR are excluded on purpose.

The embedded terminal from the design (xterm.js + node-pty) is not built: it needs a native
module, which the MVP rules out.

## Promote to comment (`src/main/promote`)

`write-client.ts` is the only code that can mutate GitHub, and only `promote.ts` imports it.
Off unless `promoteEnabled` is set (default false); every call checks it.

1. `promote:preview` resolves the note, reads the PR through GraphQL (node ID, head, the
   viewer's own pending review), refuses if the head moved since the review, and returns the
   exact comment, line, side and account plus a single-use confirm token (2 minutes). It
   writes nothing.
2. `promote:confirm` consumes the token, checks the setting and the head again, starts a
   pending review if the viewer has none (`addPullRequestReview` without an `event`, and the
   result must come back `PENDING`), then adds the comment with `addPullRequestReviewThread`
   (line or multi-line, or `subjectType: FILE` for file-level notes). The note is marked
   promoted.

Values go to `gh api graphql` with `-f` (raw strings, so a body starting with `@` is never
read as a file) and `-F` only for line numbers.

## Subjects: PRs and compare ranges

`src/shared/subject.ts`. Everything that is reviewed is a `Subject`: a PR (`owner/repo#n`) or a
compare range pinned to SHAs (`owner/repo`, base SHA, head SHA, mode). Notes, cache files and
target keys all derive from it (`subjectSlug`, `targetKeyOf`). Refs typed by the user are
validated by `GitRefName` (no `..`, `@{`, leading `-`, spaces) before they reach a `gh api`
path, then resolved to SHAs with `gh api repos/…/commits/<ref>`.

- Three-dot diffs and compare metadata (merge base, ahead/behind, up to 250 commits) come from
  `gh api …/compare/<base>...<head>` with a constant `--jq` filter.
- A two-dot range whose base is an ancestor of head is the same diff, so it uses the
  three-dot path and shares the three-dot subject (one review, one set of notes); the UI still
  labels it as direct.
- The prompt header is a `PromptContext`: `<pr …>` with description and linked issues, or
  `<compare …>` with the diff mode and commit subjects.
- Release summaries (`review/release.ts`, `release.v1`) run as a job like reviews, over commit
  subjects, the file list and the cached review's notes; `risky` may only cite real note IDs.
  They are cached next to the analysis (`<headSha>.release.json`).

## Review pipeline (`src/main/review`)

1. `gh pr view --json …` + `gh pr diff` → `diff/parse.ts` parses the unified diff, sorts files by
   path, assigns `F1…Fn` (noise files included, so IDs never shift) and per-file line IDs
   `F1-001…` counted across hunks, and marks noise files by glob.
2. `plan.ts` sends the whole PR as one prompt if it fits the chunk budget (90k input tokens).
   Otherwise `chunker.ts` plans chunks: source files stay with their tests, then files are
   grouped by top-level directory and bin-packed largest first; a file over budget is split by
   hunks. More than 8 chunks is refused with a clear message.
3. `prompt.ts` builds each `review.v1` prompt: PR header, manifest of all files (`in-chunk`,
   `other-chunk`, `noise:…`), the chunk's diff with line IDs, and the task (6 notes per chunk,
   or the note cap for a single pass). It records which IDs it showed. `secrets.ts` masks
   likely secrets first and reports them.
4. `claude.ts` runs `claude -p --output-format json --json-schema <schema>` with `--tools ""`,
   `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode dontAsk`,
   `--no-session-persistence`, from an empty sandbox dir, prompt on stdin. JSON Schemas are
   generated from the zod `ModelOutput` / `MergeOutput` in `src/shared/review.ts`, and the
   envelope is parsed with the same zod type. One retry on bad JSON.
5. `validate.ts` checks each chunk's notes against the IDs that chunk was shown: normalizes
   padding, finds an unknown start again by its quote (anchor file first, then every visible
   file; ambiguous matches are not guessed), collapses unknown or cross-file ends, swaps
   reversed spans, truncates spans to 20 lines, moves the start to the line that holds the
   quote or lowers confidence by 0.2. A note on a shown file with no locatable line becomes
   file-level; anything else is dropped with a reason.
6. `merge.ts` (several chunks only): one `merge.v1` pass over the validated candidates
   (`c2.n1`, resolved path:line, anchor line) and chunk summaries. It cannot invent anchors:
   every final note cites candidate keys and inherits the first one's anchor. If the merge
   pass fails, the candidates are kept and files/summary are combined by rule.
7. `rank.ts` scores (severity × confidence × category weight), dedupes by identity and by
   overlapping lines with the same category, drops weak low notes, and caps the list (highs
   first, so a high is never cut for a lower note).
8. `pipeline.ts` runs all of this; `service.ts` owns jobs, cancel and the shared limiter
   (at most 2 `claude` processes at once, chunks included). A failed chunk makes the
   analysis partial; only all chunks failing fails the job.

## Storage

`src/main/store/json-store.ts`: atomic JSON files (temp + rename, mode 0600, writes serialized
per file) under `app.getPath('userData')`, each read back through a zod schema.

- **Analyses** (`src/main/review/cache.ts`): one file per (subject, head SHA) at
  `analyses/<subject slug>/<headSha>.json` (a PR slug is `<owner>__<repo>__<n>`), holding `{ version, settingsKey, analysis }`.
  Opening a PR or starting a review without "Re-run" serves the file instead of calling
  `claude`; "Re-run" always runs and overwrites it. `settingsKey` hashes the prompt versions,
  model, note cap and noise globs: a hit made with other settings is still shown, flagged
  stale, so a paid-for review is never discarded silently. Unreadable or older-version files
  are a miss (logged by error name only, never content). A new push means a new head SHA and
  so a fresh review. There is no pruning yet.
- **Private notes and note state** live in `notes/<subject slug>.json`: per PR, so they
  survive new pushes, and per SHA range for a compare. AI note IDs are a hash of path, category and anchor text, so
  seen/dismissed state carries over when a re-run finds the same thing.
- **Settings** in `settings.json`; the optional Claude OAuth token in `claude-oauth.bin`,
  encrypted with `safeStorage`.

## Renderer

Feature folders under `src/renderer/src/features` (`shell`, `review`, `compare`, `settings`).
The review page serves both PRs and compares; only the header (`PrHeader` / `CompareHeader`)
differs. The design
system stylesheet is copied verbatim into `styles/ds.css`; `styles/app.css` adds the mono font,
diff and severity tokens, and a dark theme derived from the system ramps. `ds/` holds thin
React wrappers over the design-system classes. `features/review/model.ts` holds the pure view
logic (note ordering, filters, row building, intra-line highlights) and is unit-tested.

## Not built

- The embedded terminal (xterm.js + node-pty) from the design: it needs a native module, which
  the MVP rules out. Ask Claude uses an external terminal instead.
- Packaging into a signed `.app`, Linux and Windows support, and an Inbox view.
- Pruning of cached analyses and session folders.
