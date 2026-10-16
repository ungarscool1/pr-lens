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

## Review pipeline (`src/main/review`)

1. `gh pr view --json …` + `gh pr diff` → `diff/parse.ts` parses the unified diff, sorts files by
   path, assigns `F1…Fn` and per-file line IDs `F1-001…`, and marks noise files by glob.
2. `prompt.ts` builds the `review.v1` prompt: PR header, manifest of all files, diff of
   reviewed files with line IDs. `secrets.ts` masks likely secrets and reports them.
3. `claude.ts` runs `claude -p --output-format json --json-schema <ModelOutput>` with
   `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode dontAsk`,
   `--no-session-persistence`, from an empty sandbox dir, prompt on stdin. The JSON Schema is
   generated from the zod `ModelOutput` in `src/shared/review.ts`. One retry on bad JSON.
4. `validate.ts` normalizes line IDs, drops notes anchored to unknown lines, repairs reversed
   or cross-file spans, and resolves IDs to path / side / line numbers.
5. `rank.ts` scores (severity × confidence × category weight), drops weak low notes, caps the
   list without cutting a high note.
6. `service.ts` runs jobs through a limiter (2 at a time) and keeps results in memory.

## Storage

`src/main/store/json-store.ts`: atomic JSON files (temp + rename, mode 0600) under
`app.getPath('userData')`. Private notes and note state live in `notes/<owner>__<repo>__<n>.json`,
keyed by PR so they survive new pushes. AI note IDs are a hash of path, category and anchor
text, so seen/dismissed state carries over when a re-run finds the same thing.

## Renderer

Feature folders under `src/renderer/src/features` (`shell`, `review`, `settings`). The design
system stylesheet is copied verbatim into `styles/ds.css`; `styles/app.css` adds the mono font,
diff and severity tokens, and a dark theme derived from the system ramps. `ds/` holds thin
React wrappers over the design-system classes. `features/review/model.ts` holds the pure view
logic (note ordering, filters, row building, intra-line highlights) and is unit-tested.

## Not in phase 1

| Phase | Adds                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2     | Quote-based anchor repair, span limits, chunking big PRs by file/hunk + merge pass. Today PRs over ~150k input tokens are refused. |
| 3     | On-disk cache per (repo, PR, head SHA); "cached" badge. Today results live for the session only.                                   |
| 4     | Compare view (branch / tag / SHA, two-dot vs three-dot), release summary.                                                          |
| 5     | "Ask Claude": worktree of the PR head + interactive `claude` in an external terminal.                                              |
| 6     | "Promote to comment": opt-in, confirmed, pending review comment through `gh`.                                                      |
