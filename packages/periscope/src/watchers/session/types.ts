export type SessionOperation = 'initiated' | 'committed' | 'migrated'

export type SessionEntryContent = Record<string, unknown> & {
  operation: SessionOperation
  sessionIdHash: string
  fromSessionIdHash?: string
  fresh: boolean
  readonly: boolean
  modified: boolean
  values?: unknown
}
