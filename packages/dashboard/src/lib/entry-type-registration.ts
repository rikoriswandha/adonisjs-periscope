export type EntryTypeMetadataContract = {
  type: string
  path: string
  label: string
  group: string
  icon: unknown
  load: () => Promise<unknown>
}

export function registerEntryType<T extends EntryTypeMetadataContract>(metadata: T): Readonly<T> {
  if (!metadata.type || !metadata.path || !metadata.label) {
    throw new Error('Entry type metadata requires type, path, and label')
  }
  if (!metadata.icon || typeof metadata.load !== 'function') {
    throw new Error('Entry type metadata requires an icon and lazy implementation loader')
  }
  return Object.freeze(metadata)
}

export function assertUniqueEntryTypeMetadata(
  registrations: readonly EntryTypeMetadataContract[]
): void {
  const types = new Set<string>()
  const paths = new Set<string>()
  for (const registration of registrations) {
    if (types.has(registration.type)) {
      throw new Error(`Duplicate entry type registration: ${registration.type}`)
    }
    if (paths.has(registration.path)) {
      throw new Error(`Duplicate entry type path: ${registration.path}`)
    }
    types.add(registration.type)
    paths.add(registration.path)
  }
}
