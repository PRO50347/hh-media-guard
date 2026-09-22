import { normalizeLanguage } from './language'; import type { AudioTrack, Decision, Settings } from './types';
export function decideAudio(duration:number|undefined, tracks:AudioTrack[], policy:Pick<Settings,'requiredLanguages'|'allowDescriptive'|'ignoreCommentary'|'requireMainProgram'|'unknownBehavior'>): {decision:Decision;reason:string} {
 const required=policy.requiredLanguages.map(normalizeLanguage); const substantial=(t:AudioTrack)=>!duration || !t.duration || t.duration >= duration*.75;
 const usable=tracks.filter(t => required.includes(normalizeLanguage(t.language)) && (!policy.ignoreCommentary || !t.isCommentary) && (policy.allowDescriptive || !t.isDescriptive) && (!policy.requireMainProgram || substantial(t)));
 if (usable.length) return {decision:'pass',reason:`Required audio verified: ${usable.map(x=>x.language).join(', ')}`};
 if (tracks.some(t=>normalizeLanguage(t.language)==='und')) return {decision:policy.unknownBehavior,reason:'Audio language metadata is unavailable; no acceptable main-program track can be verified.'};
 return {decision:'fail',reason:`No acceptable ${required.join('/')} main-program audio track was found.`};
}
