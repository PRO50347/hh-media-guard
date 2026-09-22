import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobQueue } from '@/lib/store';
import { requireAdmin } from '@/lib/auth';
const schema=z.object({path:z.string().min(1).max(4096)});
export async function GET(){try{await requireAdmin();return NextResponse.json(jobQueue.list());}catch{return NextResponse.json({error:'Authentication required'},{status:401});}}
export async function POST(request:Request){try{await requireAdmin(true);const {path}=schema.parse(await request.json());return NextResponse.json(jobQueue.enqueue('scan-file',{path}),{status:202});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Request rejected'},{status:400});}}
