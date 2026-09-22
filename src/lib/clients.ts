import { safeRemoteUrl } from './security';

export interface ArrStatus { version: string; appName?: string; }
export interface ArrFile { id: number; path: string; size?: number; dateAdded?: string; }
export interface ArrHistory { id: number; eventType?: string; sourceTitle?: string; downloadId?: string; }

export class ArrClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  protected async request<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const base = safeRemoteUrl(this.baseUrl);
    const response = await fetch(new URL(`/api/v3${endpoint}`, base), {
      ...init, headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json', ...init.headers }, signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Arr request failed with HTTP ${response.status}`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async testConnection(): Promise<ArrStatus> { return this.request<ArrStatus>('/system/status'); }
  async history(): Promise<ArrHistory[]> { return this.request<ArrHistory[]>('/history?pageSize=1000&sortDirection=descending'); }
  async queue(): Promise<unknown> { return this.request('/queue?pageSize=1000'); }
  async command(name: string, payload: Record<string,unknown> = {}) { return this.request('/command', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ...payload }) }); }
}
export class SonarrClient extends ArrClient { async series(){return this.request<unknown[]>('/series');} async episodes(seriesId:number){return this.request<unknown[]>(`/episode?seriesId=${seriesId}`);} async episodeFiles(seriesId:number){return this.request<ArrFile[]>(`/episodefile?seriesId=${seriesId}`);} async deleteEpisodeFile(id:number){return this.request<void>(`/episodefile/${id}`,{method:'DELETE'});} async searchEpisode(episodeIds:number[]){return this.command('EpisodeSearch',{episodeIds});} }
export class RadarrClient extends ArrClient { async movies(){return this.request<unknown[]>('/movie');} async movieFiles(movieId:number){return this.request<ArrFile[]>(`/moviefile?movieId=${movieId}`);} async deleteMovieFile(id:number){return this.request<void>(`/moviefile/${id}`,{method:'DELETE'});} async searchMovie(movieIds:number[]){return this.command('MoviesSearch',{movieIds});} }
