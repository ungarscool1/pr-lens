import { AppError } from '../../../shared/errors';
import type { Result } from '../../../shared/errors';

export const api = window.prLens;

/** Unwraps an IPC result, turning a failure back into a typed AppError. */
export async function run<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw AppError.fromJSON(r.error);
  return r.data;
}

export const errorMessage = (e: unknown): string =>
  e instanceof AppError ? e.message : 'Something went wrong inside PR Lens.';

/** Opens an allow-listed https link in the system browser; main refuses anything else. */
export const openExternal = (url: string): void =>
  void run(api.shell.openExternal({ url })).catch(() => undefined);
