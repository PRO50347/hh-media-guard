import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ArrClient } from '@/lib/clients';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { integration, integrationKey, integrationResult, saveIntegration } from '@/lib/store';
import { requireAdmin } from '@/lib/auth';

const schema = z.object({ enabled:z.boolean(), url:z.string().url().max(2048).optional(), apiKey:z.string().min(1).max(512).optional() });
function id(value:string) { if(value !== 'sonarr' && value !== 'radarr') throw new Error('Unknown integration'); return value; }
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}) { try { await requireAdmin(); return NextResponse.json(integration(id((await params).id))); } catch { return NextResponse.json({error:'Authentication required'},{status:401}); } }
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}) { try { await requireAdmin(true);const data=schema.parse(await request.json());const name=id((await params).id);saveIntegration(name,data.enabled,data.url || '',data.apiKey?encryptSecret(data.apiKey):undefined);return NextResponse.json(integration(name)); } catch(error) { return NextResponse.json({error:error instanceof Error?error.message:'Configuration rejected'},{status:400}); } }
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) { try { await requireAdmin(true);const name=id((await params).id);const config=integration(name);const key=integrationKey(name);if(!config.url||!key) throw new Error('Save a URL and API key before testing.');const result=await new ArrClient(config.url,decryptSecret(key)).testConnection();integrationResult(name,result.version);return NextResponse.json({ok:true,version:result.version}); } catch(error) { const name=id((await params).id);integrationResult(name,undefined,error instanceof Error?error.message:'Connection failed');return NextResponse.json({error:error instanceof Error?error.message:'Connection failed'},{status:400}); } }
