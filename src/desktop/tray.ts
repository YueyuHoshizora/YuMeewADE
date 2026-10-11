import { app, Menu, nativeImage, Tray } from 'electron';
import { desktopLabels } from './menu.ts';

export function createTray(icon: string, origin: string, show: () => void, newWindow: () => void): () => void {
  const image = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  const tray = new Tray(image);
  const l = desktopLabels(); let stopped = false; let active: AbortController | undefined;
  const update = (count: number | null): void => {
    const running = `${l[13]}: ${count === null ? '—' : count}`;
    tray.setToolTip(`YuMeewADE · ${running}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: l[12]!, click: show }, { label: l[3]!, click: newWindow },
      { label: running, enabled: false }, { type: 'separator' }, { label: l[14]!, click: () => app.quit() },
    ]));
  };
  tray.on('click', show); update(null);
  const poll = async (): Promise<void> => {
    if (stopped || active) return;
    active = new AbortController();
    try {
      const response = await fetch(`${origin}/api/state`, { signal: AbortSignal.any([active.signal, AbortSignal.timeout(4000)]), redirect: 'error' });
      if (!response.ok) throw new Error('state unavailable');
      const state: unknown = await response.json();
      const running = state && typeof state === 'object' && 'running' in state ? state.running : null;
      if (!stopped) update(Array.isArray(running) ? running.length : null);
    } catch { if (!stopped) update(null); }
    finally { active = undefined; }
  };
  void poll(); const timer = setInterval(() => { void poll(); }, 5000);
  return () => { stopped = true; clearInterval(timer); active?.abort(); tray.destroy(); };
}
