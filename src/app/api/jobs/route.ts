import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobQueue } from '@/lib/store';
import { requireAdmin } from '@/lib/auth';
const schema=z.union([
  z.object({kind:z.literal('scan-library'),source:z.enum(['sonarr','radarr']).optional(),entityId:z.number().int().positive().optional(),seriesId:z.number().int().positive().optional(),season:z.number().int().nonnegative().optional(),filter:z.enum(['fail','needs-analysis']).optional(),force:z.boolean().optional()}),
  z.object({kind:z.literal('scan-file').optional(),path:z.string().min(1).max(4096),force:z.boolean().optional()}),
]);
export async function GET(){try{await requireAdmin();return NextResponse.json(jobQueue.list());}catch{return NextResponse.json({error:'Authentication required'},{status:401});}}
export async function POST(request:Request){try{await requireAdmin(true);const {kind,...payload}=schema.parse(await request.json());return NextResponse.json(jobQueue.enqueue(kind||'scan-file',payload),{status:202});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Request rejected'},{status:400});}}
