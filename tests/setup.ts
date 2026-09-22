import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
const config=mkdtempSync(join(tmpdir(),'media-guard-test-'));
process.env.CONFIG_DIR=config;
process.env.ALLOW_DESTRUCTIVE_ACTIONS='false';
process.env.ENCRYPTION_KEY=Buffer.alloc(32,1).toString('base64');
afterAll(()=>rmSync(config,{recursive:true,force:true}));
