export interface EmbeddedPreviewRequest { command: string; args: string[]; }
export interface EmbeddedPreviewState {
  id: string; project: string; task: string; state: 'starting' | 'running' | 'stopped' | 'failed';
  url: string; targetUrl: string; output: string; exitCode: number | null;
}
