// Release discovery never executes files; controlled download and trust verification live in update-download.ts.
import type { UpdateAsset, UpdateInfo } from '../shared/types.ts';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NOTES_MAX = 8000;

interface Parsed { core: [number, number, number]; pre: string | undefined }

function parse(text: string): Parsed | null {
  const m = SEMVER.exec(text.trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
}

/** 語意化版本比較：a>b 回正數；無法解析的版本字串視為不相關（回 NaN）。預發行版低於同號的正式版。 */
export function compareVersions(a: string, b: string): number {
  const x = parse(a); const y = parse(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

interface RawAsset { name: string; url: string; size: number }

/** 只留下適合本機作業系統與架構的檔案，並標出是安裝版還是免安裝版。 */
export function pickAssets(assets: RawAsset[], platform: NodeJS.Platform, arch: string): UpdateAsset[] {
  if (arch !== 'x64' && arch !== 'arm64') return [];
  const wantArm = arch === 'arm64';
  const found: UpdateAsset[] = [];
  for (const asset of assets) {
    const name = asset.name.toLowerCase();
    if ((/arm64|aarch64/.test(name)) !== wantArm) continue;
    let kind: UpdateAsset['kind'] | null = null;
    if (platform === 'darwin') kind = name.endsWith('.dmg') ? 'installer' : name.endsWith('.zip') ? 'portable' : null;
    else if (platform === 'win32') kind = !name.endsWith('.exe') ? null : /setup/.test(name) ? 'installer' : 'portable';
    else if (platform === 'linux') kind = name.endsWith('.deb') ? 'installer' : name.endsWith('.appimage') ? 'portable' : null;
    if (kind) found.push({ name: asset.name, url: asset.url, size: asset.size, kind });
  }
  return found.sort((p, q) => (p.kind === q.kind ? 0 : p.kind === 'installer' ? -1 : 1));
}

/** 取得最新的正式發行（草稿與預發行不在 /releases/latest 內）。任何失敗或內容不合預期都回 null。 */
export async function fetchLatestRelease(repo: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch, fetcher: typeof fetch = fetch): Promise<UpdateInfo | null> {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  try {
    const res = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'YuMeewADE-update-check' },
    });
    if (!res.ok) return null;
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (!res.body) return null;
    for await (const chunk of res.body) { bytes += chunk.length; if (bytes > 1024 * 1024) return null; chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
    if (body.draft === true || body.prerelease === true || typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null;
    const parsed = parse(body.tag_name);
    if (!parsed) return null;
    // 連結只收發行倉庫自己的 https 位址，避免回應被竄改後把使用者導去別處。
    const prefix = `https://github.com/${repo}/`;
    if (body.html_url !== `${prefix}releases/tag/${encodeURIComponent(body.tag_name)}`) return null;
    const raw: RawAsset[] = [];
    if (Array.isArray(body.assets)) {
      for (const item of body.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown }[]) {
        if (typeof item?.name === 'string' && /^[A-Za-z0-9_. -]{1,180}$/.test(item.name) && !item.name.includes('..') && typeof item.browser_download_url === 'string' && item.browser_download_url === `${prefix}releases/download/${encodeURIComponent(body.tag_name)}/${encodeURIComponent(item.name)}` && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 2 * 1024 ** 3) {
          raw.push({ name: item.name, url: item.browser_download_url, size: item.size });
        }
      }
    }
    return {
      version: body.tag_name.trim().replace(/^v/, ''),
      tag: body.tag_name,
      url: body.html_url,
      notes: typeof body.body === 'string' ? body.body.slice(0, NOTES_MAX) : '',
      assets: pickAssets(raw, platform, arch),
    };
  } catch { return null; }
}

/** 定時檢查；只有「比目前版本新」的發行才會對外呈現。查詢失敗時保留上一次的結果。 */
export class UpdateWatcher {
  private latest: UpdateInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly current: string;
  private readonly fetchLatest: () => Promise<UpdateInfo | null>;
  private readonly onChange: () => void;
  constructor(current: string, fetchLatest: () => Promise<UpdateInfo | null>, onChange: () => void) {
    this.current = current; this.fetchLatest = fetchLatest; this.onChange = onChange;
  }
  snapshot(): UpdateInfo | undefined {
    return this.latest && compareVersions(this.latest.version, this.current) > 0 ? this.latest : undefined;
  }
  async poll(intervalMs: number): Promise<void> {
    if (this.closed) return;
    const before = this.snapshot()?.version;
    const next = await this.fetchLatest();
    if (this.closed) return;
    if (next) this.latest = next;
    if (this.snapshot()?.version !== before) this.onChange();
    this.timer = setTimeout(() => { void this.poll(intervalMs); }, intervalMs);
    this.timer.unref();
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); }
}
