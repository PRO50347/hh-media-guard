import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { raw } from './store';

const SESSION_DAYS = 14;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export function passwordHash(password:string){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;}
export function verifyPassword(password:string,stored:string){const [salt,value]=stored.split(':');const actual=scryptSync(password,salt,64);return timingSafeEqual(actual,Buffer.from(value,'hex'));}
export function hasAdmin(){return Boolean(raw().prepare('SELECT 1 FROM users LIMIT 1').get());}
export function createAdmin(username:string,password:string){raw().prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)').run(randomBytes(16).toString('hex'),username,passwordHash(password),new Date().toISOString());}
export function login(username:string,password:string){const user=raw().prepare('SELECT * FROM users WHERE username=?').get(username) as any;if(!user||!verifyPassword(password,user.password_hash))return null;const token=randomBytes(32).toString('base64url');const csrf=randomBytes(24).toString('base64url');const expires=new Date(Date.now()+SESSION_DAYS*86400000).toISOString();raw().prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES(?,?,?,?,?)').run(randomBytes(16).toString('hex'),user.id,hash(token),csrf,expires);return {token,csrf,expires};}
export async function currentSession(){const token=(await cookies()).get('mg_session')?.value;if(!token)return null;return raw().prepare("SELECT sessions.csrf_token,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? ").get(hash(token),new Date().toISOString()) as {csrf_token:string;username:string}|undefined;}
export async function requireAdmin(write=false){const session=await currentSession();if(!session)throw new Error('Authentication required');if(write){const h=await headers();const app=process.env.APP_URL;const origin=h.get('origin');const allowed=[app,...(process.env.ALLOWED_ORIGINS||'').split(',')].filter(Boolean);if(!origin||!allowed.includes(origin))throw new Error('Untrusted request origin');if(h.get('x-csrf-token')!==session.csrf_token)throw new Error('Invalid CSRF token');}return session;}
export function logout(token?:string){if(token)raw().prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));}
