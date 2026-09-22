import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults, type Job, type JobState, type PathMapping, type ScanResult, type Settings } from './types';

const configDir = process.env.CONFIG_DIR || path.join(process.cwd(), 'config');
fs.mkdirSync(configDir, { recursive: true });
// Build workers must not contend for a persistent SQLite migration lock.
const db = new Database(process.env.MG_BUILD === '1' ? ':memory:' : path.join(configDir, 'media-guard.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');
const migrationSql = [
  'CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY,path TEXT NOT NULL,fingerprint TEXT UNIQUE,decision TEXT NOT NULL,reason TEXT NOT NULL,data TEXT NOT NULL,scanned_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,type TEXT NOT NULL,detail TEXT NOT NULL,actor TEXT NOT NULL DEFAULT 'system',created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS rejections(identity TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,csrf_token TEXT NOT NULL,expires_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,url TEXT,encrypted_key TEXT,version TEXT,last_tested_at TEXT,last_error TEXT); CREATE TABLE IF NOT EXISTS mappings(id TEXT PRIMARY KEY,source TEXT NOT NULL,arr_path TEXT NOT NULL,container_path TEXT NOT NULL,media_type TEXT NOT NULL,enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,progress INTEGER NOT NULL,current_item TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS branding_assets(kind TEXT PRIMARY KEY,filename TEXT NOT NULL,content_type TEXT NOT NULL); CREATE TABLE IF NOT EXISTS webhook_receipts(id TEXT PRIMARY KEY,digest TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS jobs_deduplication ON jobs(kind, payload) WHERE state IN (\'queued\',\'running\')'
];
db.exec(migrationSql[0]);
for (let i=1;i<=migrationSql.length;i+=1) if (!db.prepare('SELECT 1 FROM migrations WHERE version=?').get(i)) db.transaction(() => { db.exec(migrationSql[i-1]); db.prepare('INSERT INTO migrations VALUES(?,?)').run(i,new Date().toISOString()); })();
export function getConfigDir(){ return configDir; }
export function getSettings():Settings { const row=db.prepare('SELECT data FROM settings WHERE id=1').get() as {data:string}|undefined; return row ? {...defaults(),...JSON.parse(row.data)} : defaults(); }
export function audit(type:string,detail:string,actor='system'){ db.prepare('INSERT INTO events(type,detail,actor,created_at) VALUES(?,?,?,?)').run(type,detail,actor,new Date().toISOString()); }
export const logEvent = audit;
export function saveSettings(input:Partial<Settings>){ const value={...getSettings(),...input}; db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(value));audit('configuration','Settings updated','admin');return value; }
export function saveScan(scan:ScanResult){ db.prepare('INSERT INTO scans(path,fingerprint,decision,reason,data,scanned_at) VALUES(?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,data=excluded.data,scanned_at=excluded.scanned_at').run(scan.path,scan.fingerprint,scan.decision,scan.reason,JSON.stringify(scan),scan.scannedAt);audit('scan',`${scan.decision}: ${scan.path}`); }
export function listScans(){return (db.prepare('SELECT data FROM scans ORDER BY scanned_at DESC LIMIT 500').all() as {data:string}[]).map((row)=>JSON.parse(row.data) as ScanResult);}
export function stats(){return db.prepare("SELECT COUNT(*) total,COALESCE(SUM(decision='pass'),0) pass,COALESCE(SUM(decision='fail'),0) fail,COALESCE(SUM(decision='needs-analysis'),0) analysis FROM scans").get() as {total:number;pass:number;fail:number;analysis:number};}
export function recentEvents(){return db.prepare('SELECT type,detail,actor,created_at FROM events ORDER BY id DESC LIMIT 100').all() as {type:string;detail:string;actor:string;created_at:string}[];}
export function listMappings(){return db.prepare('SELECT * FROM mappings ORDER BY container_path').all().map((r:any):PathMapping=>({id:r.id,source:r.source,arrPath:r.arr_path,containerPath:r.container_path,mediaType:r.media_type,enabled:Boolean(r.enabled)}));}
export function addMapping(input:Omit<PathMapping,'id'>){const item={...input,id:randomUUID()};db.prepare('INSERT INTO mappings VALUES(?,?,?,?,?,?)').run(item.id,item.source,item.arrPath,item.containerPath,item.mediaType,Number(item.enabled));audit('mapping',`Added ${item.containerPath}`,'admin');return item;}
export function deleteMapping(id:string){db.prepare('DELETE FROM mappings WHERE id=?').run(id);audit('mapping',`Removed ${id}`,'admin');}
export function roots(){return listMappings().filter((m)=>m.enabled).map((m)=>m.containerPath);}
export function createJob(kind:Job['kind'],payload:unknown){const now=new Date().toISOString();const job:Job={id:randomUUID(),kind,state:'queued',payload:JSON.stringify(payload),progress:0,createdAt:now,updatedAt:now};db.prepare('INSERT INTO jobs(id,kind,state,payload,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(job.id,job.kind,job.state,job.payload,0,now,now);return job;}
export function updateJob(id:string,state:JobState,progress:number,currentItem?:string,error?:string){db.prepare('UPDATE jobs SET state=?,progress=?,current_item=?,error=?,updated_at=? WHERE id=?').run(state,progress,currentItem||null,error||null,new Date().toISOString(),id);}
export function listJobs(){return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').all().map((r:any):Job=>({id:r.id,kind:r.kind,state:r.state,payload:r.payload,progress:r.progress,currentItem:r.current_item,error:r.error,createdAt:r.created_at,updatedAt:r.updated_at}));}
export function integration(id:'sonarr'|'radarr'){const row=db.prepare('SELECT * FROM integrations WHERE id=?').get(id) as any;return row?{id,enabled:Boolean(row.enabled),url:row.url,apiKeyConfigured:Boolean(row.encrypted_key),version:row.version,lastTestedAt:row.last_tested_at,lastError:row.last_error}:{id,enabled:false,apiKeyConfigured:false};}
export function saveIntegration(id:'sonarr'|'radarr',enabled:boolean,url:string,key?:string){db.prepare('INSERT INTO integrations(id,enabled,url,encrypted_key) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,url=excluded.url,encrypted_key=COALESCE(excluded.encrypted_key,integrations.encrypted_key)').run(id,Number(enabled),url,key||null);audit('integration',`${id} configuration updated`,'admin');}
export function integrationKey(id:'sonarr'|'radarr'){return (db.prepare('SELECT encrypted_key FROM integrations WHERE id=?').get(id) as any)?.encrypted_key as string|undefined;}
export function integrationResult(id:'sonarr'|'radarr',version?:string,error?:string){db.prepare('UPDATE integrations SET version=?,last_tested_at=?,last_error=? WHERE id=?').run(version||null,new Date().toISOString(),error||null,id);}
export function acceptWebhook(digest:string){try{db.prepare('INSERT INTO webhook_receipts(id,digest,created_at) VALUES(?,?,?)').run(randomUUID(),digest,new Date().toISOString());return true;}catch{return false;}}
export function raw(){return db;}
