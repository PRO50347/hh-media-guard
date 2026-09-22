import Image from 'next/image';
import { hasAdmin,currentSession } from '@/lib/auth';
import { getSettings } from '@/lib/store';
import { brandingAssets } from '@/lib/branding';
import { LoginForm } from '@/components/LoginForm';
import { redirect } from 'next/navigation';
export default async function Login(){
  if(await currentSession())redirect('/');
  const settings=getSettings();const assets=brandingAssets();
  return <main className="auth" style={assets.background?{backgroundImage:`url("${assets.background}")`}:undefined}><section className="auth-card">{assets.logo&&<Image unoptimized className="auth-logo" src={assets.logo} width={200} height={100} alt={settings.appName}/>}<p className="eyebrow">{settings.showSuite?settings.suiteName:settings.shortName}</p><p>{settings.appName}</p><LoginForm setup={!hasAdmin()}/></section></main>;
}
