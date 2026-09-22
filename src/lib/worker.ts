import { integration, integrationKey, roots, saveScan, updateJob, jobQueue } from './store';
import { safeMediaPath } from './security';
import { scanFile } from './scanner';
import { decryptSecret } from './crypto';
import { RadarrClient, SonarrClient } from './clients';
import { enumerateRadarr, enumerateSonarr } from './library';
import { WorkerRunner } from './worker-runner';

const runner = new WorkerRunner(jobQueue, async (job, signal) => {
    if (job.kind === 'scan-library') { await runLibraryJob(job.id, JSON.parse(job.payload) as {source?:'sonarr'|'radarr'}); return; }
    if (job.kind !== 'scan-file') { jobQueue.finish(job,'needs-attention','Unsupported job type.'); return; }
    const payload = JSON.parse(job.payload) as {path?:string};
    if (!payload.path) throw new Error('Job payload has no path.');
    jobQueue.progress(job,10,payload.path);
    const file = await safeMediaPath(payload.path, roots());
    const scan = await scanFile(file);
    signal.throwIfAborted();
    if (!jobQueue.heartbeat(job)) return;
    saveScan(scan);
});

export function startWorker() {
  if (process.env.MG_BUILD === '1') return;
  runner.start();
}
export function stopWorker() { return runner.stop(); }

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
