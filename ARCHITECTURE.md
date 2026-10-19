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
- `src/main/git/git.ts` is used for direct (two-dot) compares of diverged refs (GitHub's
  compare API has no two-dot diff), deep-dive worktrees, the impact map's snapshot reads and expanded diff context.
  It keeps a bare cache repo per GitHub repo, fetches just the needed SHAs
  (`--depth=1 --filter=blob:none`), and `git diff`s them; git fetches the blobs it needs on
  demand. Credentials come from `gh auth git-credential`, never a prompt
  (`GIT_TERMINAL_PROMPT=0`).

## Deep dive (`src/main/deepdive`)

"Ask Claude" on a note:

1. `git.worktree` fetches the head SHA into the bare cache repo and adds a detached worktree
   under `userData/worktrees/<owner>__<repo>__pr<n>__<sha7>` (reused while its HEAD matches;
   least recently used beyond 10 are removed).
2. A session dir under `userData/sessions/` gets `pr.md` (note, description or commits, file
   list, the note's file diff, secrets masked), `first-message.txt` and `launch.command`
   (0700). Completed session folders are retained for 14 days and capped at 30; a `.active`
   marker protects a running terminal session from pruning.
3. `open -a <terminal app> launch.command`. The script `cd`s into the worktree, unsets
   `ANTHROPIC_API_KEY` and runs `claude --permission-mode plan --setting-sources user
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
3. `promote:submitReview` checks the setting and head once more, reuses (or starts) the
   viewer's pending review and submits it as `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`.
   Every thread already staged in that pending review is submitted together. Only comments
   explicitly promoted through step 2 ever reach GitHub; private notes and their state never do.

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
  so a fresh review. Cache heads are pruned by write time after 30 days and bounded to the 200
  most recent entries; an analysis, its release summary and its impact map are removed together.
- **Private notes and note state** live in `notes/<subject slug>.json`: per PR, so they
  survive new pushes, and per SHA range for a compare. AI note IDs are a hash of path, category and anchor text, so
  seen/dismissed state carries over when a re-run finds the same thing.
- **Settings** in `settings.json`; the optional Claude OAuth token in `claude-oauth.bin`,
  encrypted with `safeStorage`.

## Renderer

Feature folders under `src/renderer/src/features` (`shell`, `inbox`, `review`, `compare`,
`settings`). The default home view is Inbox. It independently loads the viewer, organization
membership, authored open PRs, and GitHub's documented `review-requested:@me` search (direct
requests and requests to teams the viewer belongs to). Each non-identity source is best-effort:
a SAML-gated organization is shown as unavailable without preventing accessible Inbox data from
rendering.
The review page serves both PRs and compares; only the header (`PrHeader` / `CompareHeader`)
differs. The Tailwind v4 stylesheet (`styles/tailwind.css`) owns the design tokens, semantic
component classes, diff/severity states, and the system dark theme. `ds/` holds thin React
wrappers over those classes. The diff uses blue additions and red deletions, with `+`/`−` markers
and labels so the state is never conveyed by colour alone. `features/review/model.ts` holds the
pure view logic (note ordering, filters, row building, intra-line highlights) and is unit-tested.

### Expanding unchanged lines

Each hunk header has GitHub's expand buttons: up and down reveal 20 more unchanged lines from the
hunk on that side, and one "show all" replaces them once the rest of the gap fits in a step. The
end of the file has its own row. Added, deleted and binary files have nothing hidden.

1. The first click on a file calls `diff:fileLines` with the target key and the file's `F` ID,
   never a path: main looks the file up in the loaded diff and reads it at the head SHA with
   `git.filesAt` (`ls-tree` with literal pathspecs, then the impact map's batched blob reader,
   same size bounds). `src/main/diff/context.ts`.
2. `features/review/expand.ts` (pure, tested) works out the gaps from the hunk headers: gap `i`
   before hunk `i`, one after the last, each with its old-side offset (nothing in a gap changed,
   so old = new + offset). `buildRows` emits the revealed lines as context lines marked `extra`;
   notes cannot anchor on them, since they are not in the diff the review saw.
3. `useExpansion` keeps the text and reveals per file for the loaded target. A function the impact
   map points at in a diff file but outside its hunks is revealed the shorter way into its gap,
   then centred, instead of only scrolling to the file.

### Function impact map

The Review toolbar has an **Impact** mode: a call graph of the changed functions, their direct
callers and their direct callees. It is built locally and deterministically, with no model.

1. `src/main/impact/service.ts` lists the head commit's tree in the bare cache repo
   (`git.treeEntries`) and picks up to 1,200 TypeScript/JavaScript files: changed files first,
   then their directory neighbours, then tests. Root `tsconfig*.json`/`jsconfig.json` come along
   for `paths` and `baseUrl`. `git.sourceFiles` asks `rev-list --missing=print` which blobs the
   blobless fetch left on GitHub, fetches them in one request (`fetch --stdin`, as git's own lazy
   fetch does, but batched), and reads everything with one `cat-file --batch`. No worktree.
2. `analysis.ts` runs in a worker thread (`run-worker.ts`, 2 minute limit), so the main process
   stays responsive and only the worker loads the compiler. It builds a TypeScript language
   service over the in-memory snapshot (`noLib`, no `node_modules`) and, for each changed
   declaration (the innermost function, method or class around an added or deleted line; at
   most 60), asks it for the call hierarchy: `prepareCallHierarchy`, incoming and outgoing
   calls. That is the analysis behind an editor's "Show call hierarchy", so imports through
   `paths`, re-exports, interface methods implemented by object literals and JSX usage resolve;
   calls through untyped values or into packages outside the repository are left out, not
   guessed. Context lines never mark a function as changed.
3. The map (`src/shared/impact.ts`, zod) is stored as `analyses/<subject>/<headSha>.impact.json`
   with a key of the analyzer version and the changed lines, so it is reused across restarts
   and pruned with its analysis; a new push or a changed base is a new key.
4. `impactLayout.ts` (renderer, pure) lays the graph out in columns: callers, changed
   functions (chained left to right by longest path, cycles drawn as dashed back edges),
   callees; rows follow file order, then barycenter passes. `ImpactView` draws it as SVG edges
   under HTML buttons. Clicking a changed function switches to Diff mode and centres its first
   changed line; a function elsewhere in the diff goes to its lines, revealing them when they
   sit between hunks; one outside the diff opens on GitHub at the head SHA.

#### Other languages: the user's own language servers (`src/main/impact/lsp`)

Call hierarchy is a standard LSP request, so Go and Python changes are mapped by a language
server the user installed. PR Lens ships none and never searches PATH for one: a language is
mapped only after its server's absolute path is set in Settings (`lspPaths`). Each language has
a fixed launch recipe (`presets.ts`, args and env); an arbitrary command line is not offered.

1. `service.ts` checks out the head once (`git.worktree`, named `impact__<owner>__<repo>__<sha12>`,
   sharing the deep-dive LRU) and clears every execute bit in it (`checkout.ts`, links skipped).
   A server or the tool it calls cannot then run a binary the PR ships, such as a committed
   `.venv/bin/python`.
2. `runner.ts` checks the path is executable and spawns it through `exec.ts`'s `spawnStdio`
   (no shell, base env allow-list plus the preset's values). For Go those are
   `GOTOOLCHAIN=local` (a `toolchain` line cannot download another Go), `GOPROXY=off` (only
   the user's module cache and `vendor/`) and `CGO_ENABLED=0`.
3. `analyze.ts` speaks JSON-RPC (`rpc.ts`): `initialize`, `didOpen` for changed files, waits
   for `$/progress` to go quiet, then `documentSymbol` to find the innermost function or method
   around each changed line and `prepareCallHierarchy` with incoming and outgoing calls. Items
   outside the checkout (standard library, dependencies) are dropped. It stops the server after
   3 minutes.
4. Results merge with the TypeScript map. `ImpactMap.languages` says per language whether it was
   mapped, failed (with the reason), or is off because no server is set. A map with a failed
   server is not stored, so a fixed path or a less busy server gets another try; the stored
   key includes the configured paths.

Rust is deliberately not offered: rust-analyzer's `cargo metadata` honours the repository's
`.cargo/config.toml` (`rustc-wrapper`), and build scripts and proc macros are PR code. Adding a
language means a preset whose server can load an untrusted checkout without running it.

For PRs, a separate read-only `github:prContext` call loads submitted review decisions, requested
reviewers, unresolved review threads, the head commit's check rollup, and base-branch CODEOWNERS
matched against changed files. Its GraphQL query is lazy and failure is isolated to the context
panel, so a SAML-protected organization never prevents the diff from opening.

## Packaging and delivery

`pnpm package:mac` first runs the Electron Vite production build, then `electron-builder`
packages it as an Apple Silicon app at `release/mac-arm64/PR Lens.app`. The package includes the
compiled `out/` application and its production dependencies; `release/` is a generated,
git-ignored directory.

`.github/workflows/macos-app.yml` runs on pull requests, pushes to `main`, and manual dispatch.
It installs the locked dependencies, runs typecheck, lint and tests, builds the app, then uploads
`PR Lens.app` as the `PR-Lens-macOS-arm64` workflow artifact. The CI build intentionally disables
macOS code-signing discovery, so the delivered app is unsigned and not notarized.

## Not built

- The embedded terminal (xterm.js + node-pty) from the design: it needs a native module, which
  the MVP rules out. Ask Claude uses an external terminal instead.
- macOS signing/notarization, Intel macOS builds, and Linux and Windows support.
