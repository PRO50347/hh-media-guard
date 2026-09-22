import { claimJob, integration, integrationKey, recoverStaleJobs, retryJob, roots, saveScan, updateJob } from './store';
import { safeMediaPath } from './security';
import { scanFile } from './scanner';
import { decryptSecret } from './crypto';
import { RadarrClient, SonarrClient } from './clients';
import { enumerateRadarr, enumerateSonarr } from './library';

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
    if (job.kind === 'scan-library') { await runLibraryJob(job.id, JSON.parse(job.payload) as {source?:'sonarr'|'radarr'}); return; }
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

async function runLibraryJob(id:string,payload:{source?:'sonarr'|'radarr'}) {
  const sources=(payload.source?[payload.source]:['sonarr','radarr']) as ('sonarr'|'radarr')[];
  let completed=0;
  for (const source of sources) {
    updateJob(id,'running',Math.round(completed/sources.length*100),`Enumerating ${source}`);
    const config=integration(source);const encrypted=integrationKey(source);
    if (!config.enabled || !config.url || !encrypted) { completed+=1;continue; }
    const key=decryptSecret(encrypted);
    if(source==='sonarr') await enumerateSonarr(new SonarrClient(config.url,key)); else await enumerateRadarr(new RadarrClient(config.url,key));
    completed+=1;
  }
  updateJob(id,'completed',100,'Library enumeration completed');
}
