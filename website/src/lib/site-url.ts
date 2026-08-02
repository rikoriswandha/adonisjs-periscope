export function withBasePath(path: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path)) return path

  const base = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/`
  const normalizedPath = path.replace(/^\/+/, '')
  if (path === base.slice(0, -1) || path.startsWith(base)) return path
  return `${base}${normalizedPath}`
}

export function absoluteSiteUrl(path: string, site: URL | string | undefined): string {
  const basedPath = withBasePath(path)
  return site ? new URL(basedPath, site).href : basedPath
}
