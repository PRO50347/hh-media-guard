import { claimJob, recoverStaleJobs, retryJob, roots, saveScan, updateJob } from './store';
import { safeMediaPath } from './security';
import { scanFile } from './scanner';

let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
let running = false;
const workerId = `process-${process.pid}`;

export function startWorker() {
  if (timer || process.env.MG_BUILD === '1') return;
  recoverStaleJobs();
  timer = setInterval(() => { void tick(); }, 750);
  void tick();
}
export function stopWorker() { stopping = true; if (timer) clearInterval(timer); timer = undefined; }
async function tick() {
  if (stopping || running) return;
  running = true;
  try {
    const job = claimJob(workerId);
    if (!job) return;
    if (job.kind !== 'scan-file') { updateJob(job.id,'needs-attention',100,undefined,'This job type is not available in this worker.'); return; }
    const payload = JSON.parse(job.payload) as {path?:string};
    if (!payload.path) throw new Error('Job payload has no path.');
    updateJob(job.id,'running',10,payload.path);
    const file = await safeMediaPath(payload.path, roots());
    const scan = await scanFile(file);
    saveScan(scan);
    updateJob(job.id,'completed',100,file);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker failure';
    // A job is only retried after a bounded delay; no destructive operation runs here.
    const active = claimJob(workerId, 1);
    if (active) retryJob(active.id,message);
  } finally { running = false; }
}
