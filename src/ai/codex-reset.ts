// Codex 全域重置排程：取自 codex-resets.com 的公開狀態；失敗或沒有排程一律回 null（不猜時間）。
const STATUS_URL = 'https://codex-resets.com/api/v1/status';

export async function fetchCodexReset(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(STATUS_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json() as { data?: { scheduled_reset?: { scheduled_for?: unknown } | null } };
    const at = body.data?.scheduled_reset?.scheduled_for;
    return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null;
  } catch { return null; }
}
