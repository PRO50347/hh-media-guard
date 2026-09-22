import { describe,it,expect,vi } from 'vitest';
import { detectAmbiguous,samplingPlan,type LanguageDetector } from '../src/lib/detector';
import type { ScanResult } from '../src/lib/types';
const scan:ScanResult={path:'/generated/sample',decision:'needs-analysis',reason:'Unknown',tracks:[],scannedAt:'fixture'};
const samples=[{streamIndex:0,startSeconds:20,durationSeconds:20,pcm16:new Uint8Array(100)}];
describe('optional detector contract (no model bundled)',()=>{
  it('does not invoke detection for conclusive metadata',async()=>{const detect=vi.fn();expect(await detectAmbiguous({...scan,decision:'pass'},{id:'fixture',detect},samples)).toEqual({status:'metadata'});expect(detect).not.toHaveBeenCalled();});
  it('reports the uninstalled adapter honestly',async()=>{expect(await detectAmbiguous(scan,undefined,samples)).toEqual({status:'not-installed'});});
  it('adapter failures cannot turn uncertain media into a rejection',async()=>{const detector:LanguageDetector={id:'fixture',detect:async()=>{throw new Error('Unavailable');}};expect(await detectAmbiguous(scan,detector,samples)).toEqual({status:'inconclusive'});expect(scan.decision).toBe('needs-analysis');});
  it('samples bounded distinct portions of a program',()=>{expect(samplingPlan(100,20)).toEqual([{startSeconds:20,durationSeconds:20},{startSeconds:50,durationSeconds:20},{startSeconds:80,durationSeconds:20}]);expect(samplingPlan(1,20)).toEqual([{startSeconds:0,durationSeconds:1}]);expect(()=>samplingPlan(0)).toThrow();});
});
