/**
 * Chart generation worker thread.
 * Receives a method name + args from the main thread, runs the chart
 * generation off the event loop, and posts the resulting Buffer back.
 */
import { parentPort, workerData } from 'worker_threads';
import { chartGenerationService } from '../services/chartGeneration';

(async () => {
  try {
    const { method, args } = workerData as { method: string; args: unknown[] };
    const result = await (chartGenerationService as any)[method](...args);
    parentPort!.postMessage({ ok: true, buffer: result });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: String(err) });
  }
})();
