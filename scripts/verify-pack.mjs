import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const packageRoot = new URL('../packages/periscope/', import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))

function collectExportTargets(value) {
  if (value === null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectExportTargets)
  if (typeof value === 'object') return Object.values(value).flatMap(collectExportTargets)
  throw new TypeError(`Unsupported package export target: ${JSON.stringify(value)}`)
}

function parsePackManifest(output) {
  const starts = []
  const firstNonWhitespace = output.search(/\S/)
  if (firstNonWhitespace !== -1 && output[firstNonWhitespace] === '[') {
    starts.push(firstNonWhitespace)
  }

  for (let index = output.indexOf('\n['); index !== -1; index = output.indexOf('\n[', index + 2)) {
    starts.push(index + 1)
  }

  for (const start of starts.reverse()) {
    try {
      const manifests = JSON.parse(output.slice(start).trim())
      if (manifests.length === 1 && Array.isArray(manifests[0]?.files)) {
        return manifests[0]
      }
    } catch {
      // Lifecycle output may contain bracketed log lines before npm's final JSON document.
    }
  }

  throw new Error(`npm pack did not emit a readable JSON manifest:\n${output}`)
}

const exportedFiles = Object.entries(packageJson.exports).flatMap(([specifier, target]) =>
  collectExportTargets(target).map((path) => {
    if (!path.startsWith('./') || path.includes('*')) {
      throw new Error(`Cannot verify package export ${specifier}: unsupported target ${path}`)
    }
    return { specifier, path: path.slice(2) }
  })
)

const destination = mkdtempSync(join(tmpdir(), 'periscope-pack-'))

try {
  const packed = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--json', '--silent', '--pack-destination', destination],
    { cwd: packageRoot, encoding: 'utf8' }
  )

  if (packed.status !== 0) {
    throw new Error(`npm pack failed:\n${packed.stderr || packed.stdout}`)
  }

  const manifest = parsePackManifest(packed.stdout)
  const files = new Set(manifest.files.map((file) => file.path))
  const missingExports = exportedFiles.filter(({ path }) => !files.has(path))
  const required = [
    'build/commands/commands.json',
    'build/dashboard/index.html',
    'build/stubs/config/periscope.stub',
    'build/stubs/main.js',
    'build/stubs/migrations/create_periscope_tables.stub',
    'package.json',
    'README.md',
    'LICENSE.md',
  ]
  const missingRequired = required.filter((path) => !files.has(path))
  const hasDashboardAsset = manifest.files.some(
    (file) => file.path.startsWith('build/dashboard/assets/') && file.size > 0
  )

  if (missingExports.length > 0 || missingRequired.length > 0 || !hasDashboardAsset) {
    const details = [
      missingExports.length > 0
        ? `missing export targets:\n${missingExports
            .map(({ specifier, path }) => `  ${specifier} -> ${path}`)
            .join('\n')}`
        : null,
      missingRequired.length > 0 ? `missing: ${missingRequired.join(', ')}` : null,
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
    `Verified ${manifest.filename}: ${manifest.files.length} files, ${exportedFiles.length} export targets, configure stubs, and dashboard assets present.`
  )
} finally {
  rmSync(destination, { recursive: true, force: true })
}
