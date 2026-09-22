import { normalizeLanguage } from './language';
import type { AudioTrack, Decision, Settings } from './types';
export function decideAudio(duration:number|undefined, tracks:AudioTrack[], policy:Pick<Settings,'requiredLanguages'|'allowDescriptive'|'ignoreCommentary'|'requireMainProgram'|'unknownBehavior'>): {decision:Decision;reason:string} {
  if(!duration || !Number.isFinite(duration) || duration<=0 || tracks.length===0) {
    return {decision:'needs-analysis',reason:'Program duration or audio evidence is unavailable.'};
  }
  const required=policy.requiredLanguages.map(normalizeLanguage).filter(language=>language!=='und');
  const main=tracks.filter(track=>!track.isCommentary && (policy.allowDescriptive||!track.isDescriptive) && (!track.duration||track.duration>=duration*.9));
  if(main.some(track=>required.includes(normalizeLanguage(track.language)))) {
    return {decision:'pass',reason:`Required main-program audio verified: ${required.join(', ')}`};
  }
  if(!required.length || main.some(track=>normalizeLanguage(track.language)==='und')) {
    return {decision:'needs-analysis',reason:'Main-program audio has unknown language metadata.'};
  }
  return {decision:'fail',reason:`No acceptable ${required.join('/')} main-program audio track was found.`};
}
