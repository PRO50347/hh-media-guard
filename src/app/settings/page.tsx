import Link from 'next/link';
import { IntegrationSettings } from '@/components/IntegrationSettings';
import { getSettings } from '@/lib/store';

export const dynamic = 'force-dynamic';
export default async function Settings() {
  const settings = getSettings();
  return <main className="simple"><Link href="/">← Dashboard</Link><h1>Settings</h1><IntegrationSettings id="sonarr"/><IntegrationSettings id="radarr"/><article className="card"><h2>Current safety policy</h2><p><span className="badge pass">{settings.safetyMode}</span> File and Arr mutation requires a non-monitor mode and <code>ALLOW_DESTRUCTIVE_ACTIONS=true</code>.</p></article></main>;
}
