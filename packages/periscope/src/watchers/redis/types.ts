export type RedisEntryContent = Record<string, unknown> & {
  command: string
  argumentCount: number
  arguments?: unknown
  durationMs: number
  error?: unknown
}
