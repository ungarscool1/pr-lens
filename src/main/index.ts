import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeTheme, safeStorage, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { REVIEW_EVENT_CHANNEL } from '../shared/ipc';
import type { ReviewEvent } from '../shared/review';
import { execFileRunner, spawnStdio } from './exec/exec';
import { createToolchain } from './exec/toolchain';
import { createDeepDive } from './deepdive/deepdive';
import { createContextService } from './diff/context';
import { createGit } from './git/git';
import { analyzeInWorker } from './impact/run-worker';
import { createServerRunner } from './impact/lsp/runner';
import { createImpactService } from './impact/service';
import { createPromote } from './promote/promote';
import { createWriteClient } from './promote/write-client';
import { createGhClient } from './github/gh';
import { registerIpc } from './ipc/register';
import { createNotes } from './notes/notes';
import { createAnalysisCache } from './review/cache';
import { createClaudeClient } from './review/claude';
import { createReviewService } from './review/service';
import { createSettings } from './settings/settings';
import { isAllowedExternalUrl } from '../shared/external';
import { createJsonStore } from './store/json-store';

const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = join(__dirname, '../renderer/index.html');
const rendererOrigin = devUrl ? new URL(devUrl).origin : pathToFileURL(rendererFile).href;

const isTrustedSender = (e: IpcMainInvokeEvent): boolean => {
  const url = e.senderFrame?.url ?? '';
  return devUrl ? url.startsWith(rendererOrigin) : url === rendererOrigin;
};

let win: BrowserWindow | null = null;

async function createServices(): Promise<void> {
  const data = app.getPath('userData');
  const sandboxDir = join(data, 'sandbox');
  await mkdir(sandboxDir, { recursive: true, mode: 0o700 });

  const store = createJsonStore(data);
  const settings = await createSettings(store, safeStorage, join(data, 'claude-oauth.bin'));
  const toolchain = createToolchain(execFileRunner, () => settings.current());
  const github = createGhClient(execFileRunner, toolchain);
  const claude = createClaudeClient(execFileRunner, toolchain, () => settings.oauthToken());
  const emit = (e: ReviewEvent): void => win?.webContents.send(REVIEW_EVENT_CHANNEL, e);
  // Dev-only knob to exercise chunking on mid-size PRs; packaged builds ignore it.
  const chunkBudget = !app.isPackaged
    ? Number(process.env.PR_LENS_CHUNK_BUDGET) || undefined
    : undefined;
  const cache = createAnalysisCache(store, join(data, 'analyses'));
  void cache.prune();
  const git = createGit(execFileRunner, toolchain, {
    repos: join(data, 'git'),
    worktrees: join(data, 'worktrees'),
  });
  const review = createReviewService({
    github,
    git,
    claude,
    settings,
    sandboxDir,
    emit,
    cache,
    chunkBudget,
  });
  const notes = createNotes(store);
  const deepDive = createDeepDive({
    exec: execFileRunner,
    toolchain,
    git,
    review,
    cache,
    notes,
    settings,
    sessionsDir: join(data, 'sessions'),
  });
  const impact = createImpactService({
    git,
    review,
    cache,
    analyze: analyzeInWorker,
    servers: {
      paths: () => settings.current().lspPaths,
      run: createServerRunner(toolchain, spawnStdio),
    },
  });
  const context = createContextService({ git, review });
  // The write client exists only for promote; nothing else can reach a GitHub mutation.
  const promote = createPromote({
    write: createWriteClient(execFileRunner, toolchain),
    review,
    cache,
    notes,
    settings,
  });
  registerIpc(
    { toolchain, github, claude, settings, review, notes, deepDive, promote, impact, context },
    isTrustedSender,
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: 'PR Lens',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161819' : '#f2f2f3',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererFile);
}

// Every web contents: no navigation away from the app, no popups, no webviews.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(rendererOrigin)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  // Only clipboard writes (the "Copy" buttons) are allowed; camera, notifications, etc. are not.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'clipboard-sanitized-write'),
  );
  await createServices();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
