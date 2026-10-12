// 原生橋接只接受本視窗、核心同源的 frame；不信任 renderer 傳入值。
export function acceptsFrame(frameUrl: string | undefined, coreOrigin: string): boolean {
  if (!frameUrl || !coreOrigin) return false;
  try { return new URL(frameUrl).origin === coreOrigin; } catch { return false; }
}

/**
 * Electron grants every permission by default, through two paths: requests (prompting APIs) and checks (APIs that only ask
 * whether permission is already granted, such as `queryLocalFonts`). Both use this predicate: only the IDE's own top-level
 * page gets notifications and the copy buttons' clipboard writes.
 */
export function grantsPermission(permission: string, isMainFrame: boolean, requestingUrl: string | undefined, coreOrigin: string): boolean {
  return (permission === 'notifications' || permission === 'clipboard-sanitized-write') && isMainFrame && acceptsFrame(requestingUrl, coreOrigin);
}

export function validBadgeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999;
}
