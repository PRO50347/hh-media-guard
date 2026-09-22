import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addMapping, deleteMapping, listMappings } from '@/lib/store';
import { requireAdmin } from '@/lib/auth';
const schema=z.object({source:z.enum(['sonarr','radarr','generic']),arrPath:z.string().startsWith('/').max(1024),containerPath:z.string().startsWith('/').max(1024),mediaType:z.enum(['tv','movies','anime','kids','other']),enabled:z.boolean()});
export async function GET(){try{await requireAdmin();return NextResponse.json(listMappings());}catch{return NextResponse.json({error:'Authentication required'},{status:401});}}
export async function POST(request:Request){try{await requireAdmin(true);const data=schema.parse(await request.json());return NextResponse.json(addMapping(data),{status:201});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Invalid mapping'},{status:400});}}
export async function DELETE(request:Request){try{await requireAdmin(true);const id=new URL(request.url).searchParams.get('id');if(!id)return NextResponse.json({error:'Mapping id required'},{status:400});deleteMapping(id);return NextResponse.json({ok:true});}catch{return NextResponse.json({error:'Request rejected'},{status:403});}}
