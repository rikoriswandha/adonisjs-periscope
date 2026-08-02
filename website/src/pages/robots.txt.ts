import { config } from 'virtual:nimbus/config'
import { absoluteSiteUrl } from '@/lib/site-url'

export const prerender = true

export function GET() {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absoluteSiteUrl('/sitemap-index.xml', config.site)}`,
    '',
  ].join('\n')

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
