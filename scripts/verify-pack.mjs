import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const destination = mkdtempSync(join(tmpdir(), 'periscope-pack-'))

try {
  const packed = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--workspace', 'adonisjs-periscope', '--json', '--pack-destination', destination],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' }
  )

  if (packed.status !== 0) {
    throw new Error(`npm pack failed:\n${packed.stderr || packed.stdout}`)
  }

  const [manifest] = JSON.parse(packed.stdout)
  const files = new Set(manifest.files.map((file) => file.path))
  const required = [
    'build/dashboard/index.html',
    'build/src/index.js',
    'build/providers/periscope_provider.js',
    'package.json',
    'README.md',
    'LICENSE.md',
  ]
  const missing = required.filter((path) => !files.has(path))
  const hasDashboardAsset = manifest.files.some(
    (file) => file.path.startsWith('build/dashboard/assets/') && file.size > 0
  )

  if (missing.length > 0 || !hasDashboardAsset) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
      !hasDashboardAsset ? 'missing: a non-empty build/dashboard/assets/* file' : null,
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(`Published tarball is incomplete:\n${details}`)
  }

  const tarball = join(destination, manifest.filename)
  if (statSync(tarball).size === 0) {
    throw new Error(`npm pack created an empty tarball at ${tarball}`)
  }

  console.log(
    `Verified ${manifest.filename}: ${manifest.files.length} files, dashboard entry and assets present.`
  )
} finally {
  rmSync(destination, { recursive: true, force: true })
}
