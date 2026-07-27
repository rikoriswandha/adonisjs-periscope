export function normalizeMonitoredTags(tags: readonly string[]): string[] {
  return [...tags].sort((left, right) => left.localeCompare(right))
}

export function setMonitoredTag(tags: string[], tag: string, monitored: boolean): string[] {
  if (tags.includes(tag) === monitored) return tags
  return monitored ? normalizeMonitoredTags([...tags, tag]) : tags.filter((item) => item !== tag)
}
