export interface CareCapacity { usedBytes: number; availableBytes: number; totalBytes: number; backups: number }
export interface CareSchedule { enabled: boolean; intervalHours: number; retention: number; includeExternal: boolean }
export interface CareLifecycle { schedule: CareSchedule; running: boolean; lastAttempt: string | null; lastSuccess: string | null; lastFailure: string | null; nextAttempt: string | null }
