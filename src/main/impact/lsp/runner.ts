import type { DiffModel } from '../../../shared/diff';
import type { ImpactMap } from '../../../shared/impact';
import { LSP_LANGUAGES } from '../../../shared/lsp';
import type { LspLanguage } from '../../../shared/lsp';
import type { SpawnStdio } from '../../exec/exec';
import { isExecutable } from '../../exec/resolve-bin';
import { serverEnv } from '../../exec/toolchain';
import type { ToolchainService } from '../../exec/toolchain';
import { analyzeWithServer } from './analyze';
import { SERVER_PRESETS } from './presets';

/** Runs the server the user named, with the base env plus its preset's fixed values. */
export function createServerRunner(toolchain: ToolchainService, spawn: SpawnStdio) {
  return async (run: {
    language: LspLanguage;
    command: string;
    root: string;
    diff: DiffModel;
    scannedFiles: number;
  }): Promise<ImpactMap> => {
    if (!(await isExecutable(run.command)))
      throw new Error(
        `${run.command} is not an executable ${LSP_LANGUAGES[run.language].server}. Check the path in Settings.`,
      );
    const tc = await toolchain.get();
    return analyzeWithServer({
      ...run,
      env: serverEnv(tc, SERVER_PRESETS[run.language].env),
      spawn,
    });
  };
}
