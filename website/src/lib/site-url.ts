export function withBasePath(path: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path)) return path

  const base = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/`
  const normalizedPath = path.replace(/^\/+/, '')
  if (path === base.slice(0, -1) || path.startsWith(base)) return path
  return `${base}${normalizedPath}`
}
export function withoutBasePath(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '')
  if (!base || base === '/') return path
  if (path === base || path === `${base}/`) return '/'
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path
}

export function absoluteSiteUrl(path: string, site: URL | string | undefined): string {
  const basedPath = withBasePath(path)
  return site ? new URL(basedPath, site).href : basedPath
}
