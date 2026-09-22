import {spawnSync} from 'node:child_process';
const result=spawnSync('git',['grep','-I','-n','-E','(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)'],{encoding:'utf8'});
const text=result.stdout||'';
if(text.trim()){console.error('Potential committed secret:\n'+text);process.exit(1)}
