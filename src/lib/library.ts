import path from 'node:path';
import { RadarrClient, SonarrClient } from './clients';
import { listMappings, upsertMediaItem } from './store';

export function translateArrPath(source:'sonarr'|'radarr', input:string) {
  const mapping=listMappings().filter((item)=>item.enabled&&(item.source===source||item.source==='generic')).sort((a,b)=>b.arrPath.length-a.arrPath.length).find((item)=>input===item.arrPath||input.startsWith(`${item.arrPath}/`));
  if(!mapping)return undefined;
  const suffix=path.posix.relative(mapping.arrPath,input);
  return suffix.startsWith('..')||path.posix.isAbsolute(suffix)?undefined:path.posix.join(mapping.containerPath,suffix);
}
export async function enumerateSonarr(client:SonarrClient){let count=0;for(const series of await client.series() as {id:number}[])for(const episode of await client.episodes(series.id) as any[]){if(!episode.episodeFile?.path)continue;const file=translateArrPath('sonarr',episode.episodeFile.path);if(!file)continue;upsertMediaItem({source:'sonarr',arrId:episode.id,title:episode.title||'Unknown episode',path:file,identity:String(episode.episodeFile.id||episode.id)});count++;}return count;}
export async function enumerateRadarr(client:RadarrClient){let count=0;for(const movie of await client.movies() as any[]){if(!movie.movieFile?.path)continue;const file=translateArrPath('radarr',movie.movieFile.path);if(!file)continue;upsertMediaItem({source:'radarr',arrId:movie.id,title:movie.title||'Unknown movie',path:file,identity:String(movie.movieFile.id||movie.id)});count++;}return count;}
