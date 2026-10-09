// 原生橋接只接受本視窗、核心同源的 frame；不信任 renderer 傳入值。
export function acceptsFrame(frameUrl: string | undefined, coreOrigin: string): boolean {
  if (!frameUrl || !coreOrigin) return false;
  try { return new URL(frameUrl).origin === coreOrigin; } catch { return false; }
}

export function validBadgeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999;
}
