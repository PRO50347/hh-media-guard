import { describe, expect, it } from 'vitest';
import { isCommentary, isDescriptive, normalizeLanguage } from '../src/lib/language';
import { decideAudio } from '../src/lib/rules';
import { defaults, type AudioTrack } from '../src/lib/types';

const track=(language:string,extra:Partial<AudioTrack>={}):AudioTrack=>({index:0,codec:'aac',language,isDefault:true,isCommentary:false,isDescriptive:false,...extra});
describe('language evidence',()=>{
  it.each([['EN','eng'],['en-US','eng'],['English (US)','eng'],['fre','fra'],['French','fra'],['German','deu'],['ger','deu'],['Japanese','jpn'],['español','spa'],['und','und'],['','und'],['nonsense','und']])('normalizes %s', (input,expected)=>expect(normalizeLanguage(input)).toBe(expected));
  it('does not conflate descriptive audio with commentary',()=>{expect(isCommentary('Audio Description')).toBe(false);expect(isDescriptive('Audio Description')).toBe(true);});
  it('always rejects commentary as main-program evidence',()=>expect(decideAudio(600,[track('eng',{isCommentary:true})],{...defaults(),ignoreCommentary:false}).decision).toBe('fail'));
  it('accepts descriptive audio only when configured',()=>{
    const tracks=[track('eng',{isDescriptive:true})];
    expect(decideAudio(600,tracks,defaults()).decision).toBe('fail');
    expect(decideAudio(600,tracks,{...defaults(),allowDescriptive:true}).decision).toBe('pass');
  });
  it.each([0,NaN,undefined])('does not fail conclusively for invalid duration %s',duration=>expect(decideAudio(duration,[track('spa')],defaults()).decision).toBe('needs-analysis'));
  it('does not conclusively fail missing audio',()=>expect(decideAudio(600,[],defaults()).decision).toBe('needs-analysis'));
  it('unknown main audio overrides foreign-tag failures',()=>expect(decideAudio(600,[track('spa'),track('und')],defaults()).decision).toBe('needs-analysis'));
});
