'use client';
import { useEffect, useState } from 'react';

type Config = { id:string; enabled:boolean; url?:string; apiKeyConfigured:boolean; version?:string; lastError?:string };
export function IntegrationSettings({ id }: { id:'sonarr'|'radarr' }) {
  const [config,setConfig]=useState<Config>(); const [apiKey,setApiKey]=useState(''); const [message,setMessage]=useState('');
  useEffect(()=>{fetch(`/api/integrations/${id}`).then(r=>r.json()).then(setConfig);},[id]);
  const csrf=()=>sessionStorage.getItem('mg_csrf')||'';
  async function save(){if(!config)return;const response=await fetch(`/api/integrations/${id}`,{method:'PUT',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify({...config,apiKey:apiKey||undefined})});const data=await response.json();setMessage(response.ok?'Saved. API key remains write-only.':data.error);if(response.ok){setConfig(data);setApiKey('');}}
  async function test(){const response=await fetch(`/api/integrations/${id}`,{method:'POST',headers:{'x-csrf-token':csrf()}});const data=await response.json();setMessage(response.ok?`Connected: ${data.version}`:data.error);}
  if(!config)return <p className="muted">Loading {id}…</p>;
  return <article className="card"><h2>{id[0].toUpperCase()+id.slice(1)}</h2><label><input type="checkbox" checked={config.enabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/> Enabled</label><label>Server URL<input value={config.url||''} onChange={e=>setConfig({...config,url:e.target.value})}/></label><label>API key {config.apiKeyConfigured&&<small>(configured)</small>}<input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} /></label><div className="actions"><button className="button" onClick={save}>Save</button><button onClick={test}>Test connection</button></div>{config.version&&<p className="muted">Detected version: {config.version}</p>}{config.lastError&&<p className="error">{config.lastError}</p>}{message&&<p role="status">{message}</p>}</article>;
}
