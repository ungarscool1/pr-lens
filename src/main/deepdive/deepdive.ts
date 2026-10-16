import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../shared/errors';
import type { Exec } from '../exec/exec';
import { requireBin } from '../exec/toolchain';
import type { ToolchainService } from '../exec/toolchain';
import type { GitService } from '../git/git';
import type { NotesService } from '../notes/notes';
import { resolveNote } from '../notes/resolve';
import type { AnalysisCache } from '../review/cache';
import type { ReviewService } from '../review/service';
import { repoOf } from '../../shared/subject';
import type { SettingsService } from '../settings/settings';
import { contextMarkdown, firstMessage, launchScript, worktreeName } from './session';

export interface DeepDiveResult {
  worktreePath: string;
  /** Runnable by hand (`sh <path>`) if the terminal app did not open. */
  scriptPath: string;
  terminalApp: string;
}

export interface DeepDiveService {
  open(targetKey: string, noteId: string): Promise<DeepDiveResult>;
}

interface Deps {
  exec: Exec;
  toolchain: ToolchainService;
  git: GitService;
  review: Pick<ReviewService, 'loaded'>;
  cache: AnalysisCache;
  notes: NotesService;
  settings: SettingsService;
  sessionsDir: string;
  platform?: NodeJS.Platform;
}

/** Opens one external terminal with an interactive, plan-mode claude in a worktree of the head. */
export function createDeepDive(d: Deps): DeepDiveService {
  return {
    async open(key, noteId) {
      if ((d.platform ?? process.platform) !== 'darwin') {
        throw new AppError('BAD_INPUT', 'Ask Claude opens Terminal and is macOS-only for now.');
      }
      const loaded = d.review.loaded(key);
      if (!loaded) throw new AppError('BAD_INPUT', 'Open it again before asking Claude.');
      const note = await resolveNote(
        { cache: d.cache, notes: d.notes, settings: () => d.settings.current() },
        loaded,
        noteId,
      );
      const { subject, headSha } = loaded.target;
      const tc = await d.toolchain.get();
      const claude = requireBin(tc.claude, 'claude');

      const worktreePath = await d.git.worktree(
        repoOf(subject),
        headSha,
        worktreeName(subject, headSha),
      );

      // ponytail: session dirs are never cleaned up (a few KB each); prune by age if they pile up.
      const sessionDir = join(d.sessionsDir, `${Date.now()}-${randomBytes(4).toString('hex')}`);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const contextPath = join(sessionDir, 'pr.md');
      const messageFile = join(sessionDir, 'first-message.txt');
      const scriptPath = join(sessionDir, 'launch.command');
      const file = loaded.diff.files.find((f) => f.path === note.path);
      await writeFile(
        contextPath,
        contextMarkdown(subject, loaded.header, headSha, note, file, loaded.diff.files),
        { mode: 0o600 },
      );
      await writeFile(
        messageFile,
        firstMessage(subject, loaded.header, headSha, note, contextPath),
        { mode: 0o600 },
      );
      await writeFile(
        scriptPath,
        launchScript({ worktree: worktreePath, claude, sessionDir, messageFile }),
        { mode: 0o700 },
      );
      await chmod(scriptPath, 0o700);

      // `open -a <app> <file>`: the app is a validated name from Settings, passed as one argv entry.
      const terminalApp = d.settings.current().terminalApp;
      const r = await d.exec({
        file: '/usr/bin/open',
        args: ['-a', terminalApp, scriptPath],
        timeoutMs: 15_000,
      });
      if (r.code !== 0) {
        throw new AppError(
          'EXEC_FAILED',
          `Could not open ${terminalApp}. Run it yourself: sh ${scriptPath}`,
        );
      }
      return { worktreePath, scriptPath, terminalApp };
    },
  };
}
