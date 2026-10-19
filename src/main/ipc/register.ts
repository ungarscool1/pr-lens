import { ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { AppError } from '../../shared/errors';
import type { Result } from '../../shared/errors';
import { contract } from '../../shared/ipc';
import type { Channel, Output } from '../../shared/ipc';
import type { z } from 'zod';
import type { ToolchainService } from '../exec/toolchain';
import type { GitHubClient } from '../github/gh';
import type { DeepDiveService } from '../deepdive/deepdive';
import type { ContextService } from '../diff/context';
import type { ImpactService } from '../impact/service';
import type { NotesService } from '../notes/notes';
import type { PromoteService } from '../promote/promote';
import type { ClaudeClient } from '../review/claude';
import type { ReviewService } from '../review/service';
import type { SettingsService } from '../settings/settings';
import { isAllowedExternalUrl } from '../shell/external';

export interface Services {
  toolchain: ToolchainService;
  github: GitHubClient;
  claude: ClaudeClient;
  settings: SettingsService;
  review: ReviewService;
  notes: NotesService;
  deepDive: DeepDiveService;
  promote: PromoteService;
  impact: ImpactService;
  context: ContextService;
}

type Handler<C extends Channel> = (
  input: z.output<(typeof contract)[C]['input']>,
) => Promise<Output<C>> | Output<C>;

export function registerIpc(
  s: Services,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean,
): void {
  const handle = <C extends Channel>(channel: C, fn: Handler<C>): void => {
    ipcMain.handle(channel, async (event, raw: unknown): Promise<Result<Output<C>>> => {
      if (!isTrustedSender(event))
        return { ok: false, error: { code: 'INTERNAL', message: 'Untrusted sender.' } };
      const parsed = contract[channel].input.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'BAD_INPUT',
            message: parsed.error.issues[0]?.message ?? 'Invalid request.',
          },
        };
      }
      try {
        return { ok: true, data: await fn(parsed.data as z.output<(typeof contract)[C]['input']>) };
      } catch (err) {
        const e = AppError.from(err);
        // Log the code and channel only: messages can quote command output, never diffs or tokens.
        if (e.code === 'INTERNAL')
          console.error(`[ipc] ${channel} failed`, err instanceof Error ? err.name : '');
        return { ok: false, error: e.toJSON() };
      }
    });
  };

  handle('health:check', async () => {
    s.toolchain.reset();
    const [gh, claude] = await Promise.all([s.github.health(), s.claude.health()]);
    return { gh, claude };
  });
  handle('settings:get', () => s.settings.view());
  handle('settings:update', async (patch) => {
    const view = await s.settings.update(patch);
    if ('ghPath' in patch || 'claudePath' in patch) s.toolchain.reset();
    return view;
  });
  handle('settings:setOAuthToken', ({ token }) => s.settings.setOAuthToken(token));
  handle('github:openPr', ({ input }) => s.review.openPr(input));
  handle('github:inbox', () => s.github.inbox());
  handle('github:prContext', ({ input }) => s.github.prContext(input));
  handle('github:openCompare', (input) => s.review.openCompare(input));
  handle('github:searchRefs', ({ owner, repo, query }) =>
    s.github.searchRefs({ owner, repo }, query),
  );
  handle('review:start', ({ targetKey, force, kind }) => s.review.start(targetKey, force, kind));
  handle('review:cancel', ({ jobId }) => s.review.cancel(jobId));
  handle('impact:get', ({ targetKey }) => s.impact.get(targetKey));
  handle('diff:fileLines', async ({ targetKey, fid }) => ({
    lines: await s.context.fileLines(targetKey, fid),
  }));
  handle('notes:list', ({ subject }) => s.notes.list(subject));
  handle('notes:create', ({ subject, ...note }) => s.notes.create(subject, note));
  handle('notes:delete', ({ subject, id }) => s.notes.delete(subject, id));
  handle('notes:patchState', ({ subject, id, patch }) => s.notes.patchState(subject, id, patch));
  handle('deepDive:open', ({ targetKey, noteId }) => s.deepDive.open(targetKey, noteId));
  handle('promote:preview', ({ targetKey, noteId }) => s.promote.preview(targetKey, noteId));
  handle('promote:confirm', ({ confirmToken, body }) => s.promote.confirm(confirmToken, body));
  handle('promote:submitReview', ({ targetKey, event, body }) =>
    s.promote.submitReview(targetKey, event, body),
  );
  handle('shell:openExternal', async ({ url }) => {
    if (!isAllowedExternalUrl(url))
      throw new AppError('BAD_INPUT', 'That link is not on the allow-list.');
    await shell.openExternal(url);
  });
}
