import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdmin, hasAdmin, login, logout } from '@/lib/auth';
const body=z.object({username:z.string().min(3).max(64),password:z.string().min(12).max(256)});
export async function GET(){return NextResponse.json({setupRequired:!hasAdmin()});}
export async function POST(request:Request){const input=body.safeParse(await request.json());if(!input.success)return NextResponse.json({error:'Use a username and a password of at least 12 characters.'},{status:400});if(!hasAdmin())createAdmin(input.data.username,input.data.password);const session=login(input.data.username,input.data.password);if(!session)return NextResponse.json({error:'Invalid credentials'},{status:401});const response=NextResponse.json({ok:true,csrfToken:session.csrf});response.cookies.set('mg_session',session.token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',path:'/',expires:new Date(session.expires)});return response;}
export async function DELETE(){return NextResponse.json({ok:true});}
