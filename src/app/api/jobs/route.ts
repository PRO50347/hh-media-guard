import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createJob, listJobs, roots, saveScan, updateJob } from '@/lib/store';
import { safeMediaPath } from '@/lib/security';
import { scanFile } from '@/lib/scanner';
import { requireAdmin } from '@/lib/auth';
const schema=z.object({path:z.string().min(1).max(4096)});
export async function GET(){try{await requireAdmin();return NextResponse.json(listJobs());}catch{return NextResponse.json({error:'Authentication required'},{status:401});}}
export async function POST(request:Request){try{await requireAdmin(true);const {path}=schema.parse(await request.json());const job=createJob('scan-file',{path});void runFileJob(job.id,path);return NextResponse.json(job,{status:202});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Request rejected'},{status:400});}}
async function runFileJob(id:string,input:string){try{updateJob(id,'running',5,input);const file=await safeMediaPath(input,roots());const result=await scanFile(file);saveScan(result);updateJob(id,'completed',100,file);}catch(error){updateJob(id,'failed',100,input,error instanceof Error?error.message:'Unknown failure');}}
