import { AppError } from '../../shared/errors';
import type { ImpactMap } from '../../shared/impact';
import type { ImpactInput } from './analysis';
import createWorker from './worker?nodeWorker';

const TIMEOUT_MS = 120_000;

type Reply = { ok: true; map: ImpactMap } | { ok: false; name: string };

/** Runs one analysis in a fresh worker thread, stopped after a timeout. */
export function analyzeInWorker(input: ImpactInput): Promise<ImpactMap> {
  return new Promise((resolve, reject) => {
    const worker = createWorker({ workerData: input });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new AppError('TIMEOUT', 'Building the impact map took too long and was stopped.'));
    }, TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once('message', (reply: Reply) => {
      done();
      if (reply.ok) resolve(reply.map);
      else {
        console.warn('[impact] analysis failed:', reply.name);
        reject(
          new AppError('EXEC_FAILED', 'The TypeScript language service could not map this change.'),
        );
      }
    });
    worker.once('error', (err) => {
      done();
      console.warn('[impact] worker failed:', err.name);
      reject(new AppError('EXEC_FAILED', 'The impact map worker stopped unexpectedly.'));
    });
  });
}
