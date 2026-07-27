/*
 * Dependency audit gate for shipped workspaces.
 *
 * npm has no first-party advisory allow-list. Keep the single reviewed exception here, next to
 * the code that fails closed for every advisory not named below. Development-only benchmark
 * dependencies are excluded because they are never present in the published package or SPA.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

interface Advisory {
  url: string
  title: string
  severity: string
}

interface Vulnerability {
  via: Array<string | Advisory>
}

interface AuditReport {
  vulnerabilities: Record<string, Vulnerability>
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..')
const REVIEWED_ADVISORIES = new Map([
  [
    'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
    'React Router RSC action dispatch is unreachable: Periscope is a client-only HashRouter SPA and defines no RSC routes, actions, or server functions.',
  ],
])

const environment = { ...process.env }
for (const name of Object.keys(environment)) {
  if (name.toLowerCase().startsWith('npm_')) delete environment[name]
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const audit = spawnSync(
  npm,
  ['audit', '--omit=dev', '--json', '--workspaces', '--include-workspace-root'],
  {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }
)

if (audit.error !== undefined) throw audit.error
if (audit.stdout.trim() === '') {
  throw new Error(`npm audit returned no JSON\n${audit.stderr}`)
}

const report = JSON.parse(audit.stdout) as AuditReport
const vulnerabilities = report.vulnerabilities ?? {}
const memo = new Map<string, boolean>()

function reviewed(name: string, visiting = new Set<string>()): boolean {
  const cached = memo.get(name)
  if (cached !== undefined) return cached
  if (visiting.has(name)) return false

  const vulnerability = vulnerabilities[name]
  if (vulnerability === undefined) return false

  visiting.add(name)
  const accepted = vulnerability.via.every((cause) => {
    if (typeof cause === 'string') return reviewed(cause, visiting)
    return REVIEWED_ADVISORIES.has(cause.url)
  })
  visiting.delete(name)
  memo.set(name, accepted)

  return accepted
}

const unexpected = Object.keys(vulnerabilities).filter((name) => !reviewed(name))
if (unexpected.length > 0) {
  throw new Error(
    `Dependency audit found unreviewed production vulnerabilities: ${unexpected.join(', ')}\n${audit.stdout}`
  )
}

for (const vulnerability of Object.values(vulnerabilities)) {
  for (const cause of vulnerability.via) {
    if (typeof cause === 'string') continue
    const rationale = REVIEWED_ADVISORIES.get(cause.url)
    if (rationale !== undefined) {
      console.log(`Reviewed advisory ${cause.url}: ${rationale}`)
    }
  }
}

console.log(
  `Dependency audit passed: ${Object.keys(vulnerabilities).length} package finding(s), all reviewed and non-applicable`
)
