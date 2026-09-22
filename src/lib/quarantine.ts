import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createQuarantine, getSettings, quarantine, restoreQuarantine, roots } from './store';
import { safeMediaPath } from './security';

function permitted() { return process.env.ALLOW_DESTRUCTIVE_ACTIONS === 'true' && getSettings().safetyMode === 'quarantine'; }
function filename(value:string) { return path.basename(value).replace(/[^a-zA-Z0-9._-]/g,'_'); }
export async function moveToQuarantine(source:string,evidence:string) {
  if(!permitted()) throw new Error('Quarantine requires explicit safety mode and ALLOW_DESTRUCTIVE_ACTIONS=true.');
  const original=await safeMediaPath(source,roots());const root=getSettings().quarantinePath;
  if(!root||!path.isAbsolute(root)) throw new Error('Configure an absolute quarantine path.');
  await mkdir(root,{recursive:true});const target=path.join(root,`${Date.now()}-${filename(original)}`);
  try { await rename(original,target); } catch(error:any) { if(error?.code!=='EXDEV') throw error; await copyFile(original,target);try { await unlink(original); } catch(removeError) { await unlink(target).catch(()=>undefined);throw removeError; } }
  return createQuarantine(original,target,evidence);
}
export async function restoreFromQuarantine(id:string) {
  if(!permitted()) throw new Error('Restore requires explicit safety mode and ALLOW_DESTRUCTIVE_ACTIONS=true.');
  const item=quarantine(id);if(!item||item.state!=='quarantined') throw new Error('Active quarantine record not found.');
  await mkdir(path.dirname(item.original_path),{recursive:true});try { await rename(item.quarantine_path,item.original_path); } catch(error:any) { if(error?.code!=='EXDEV') throw error;await copyFile(item.quarantine_path,item.original_path);await unlink(item.quarantine_path); }restoreQuarantine(id);
}
