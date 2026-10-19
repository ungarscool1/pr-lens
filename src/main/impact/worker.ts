import { parentPort, workerData } from 'node:worker_threads';
import { analyzeImpact } from './analysis';
import type { ImpactInput } from './analysis';

// Building a language service over a large snapshot takes seconds of CPU; it runs here so the
// main process keeps answering the window meanwhile.
try {
  parentPort?.postMessage({ ok: true, map: analyzeImpact(workerData as ImpactInput) });
} catch (err) {
  parentPort?.postMessage({ ok: false, name: err instanceof Error ? err.name : 'unknown' });
}
