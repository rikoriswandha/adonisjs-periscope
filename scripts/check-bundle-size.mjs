import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const assetsDirectory = fileURLToPath(
  new URL('../packages/periscope/build/dashboard/assets/', import.meta.url)
)

// Baseline measured on 2026-08-02: JS total 441,316 B / largest 124,533 B;
// CSS total and largest 23,234 B. Budgets allow approximately 20% growth.
const budgets = {
  js: { total: 529_600, largest: 149_500 },
  css: { total: 27_900, largest: 27_900 },
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} B (${(bytes / 1024).toFixed(2)} KiB)`
}

function collectAssets(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectAssets(path) : [path]
  })
}

let assetPaths
try {
  assetPaths = collectAssets(assetsDirectory)
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Dashboard assets are missing. Build the dashboard before checking bundle sizes.')
    process.exit(1)
  }
  throw error
}

const measurements = Object.fromEntries(
  Object.keys(budgets).map((kind) => {
    const chunks = assetPaths
      .filter((path) => extname(path) === `.${kind}`)
      .map((path) => ({
        path: relative(assetsDirectory, path),
        gzipSize: gzipSync(readFileSync(path)).byteLength,
      }))
      .sort((left, right) => right.gzipSize - left.gzipSize)

    if (chunks.length === 0) {
      console.error(`No emitted ${kind.toUpperCase()} assets found in ${assetsDirectory}`)
      process.exit(1)
    }

    return [
      kind,
      {
        chunks,
        total: chunks.reduce((sum, chunk) => sum + chunk.gzipSize, 0),
        largest: chunks[0],
      },
    ]
  })
)

const violations = []
for (const [kind, measurement] of Object.entries(measurements)) {
  const budget = budgets[kind]
  console.log(
    `${kind.toUpperCase()}: ${measurement.chunks.length} chunk(s), gzip total ${formatBytes(measurement.total)} / ${formatBytes(budget.total)}`
  )
  console.log(
    `  largest: ${measurement.largest.path} at ${formatBytes(measurement.largest.gzipSize)} / ${formatBytes(budget.largest)}`
  )

  if (measurement.total > budget.total) {
    violations.push(
      `${kind.toUpperCase()} gzip total is ${formatBytes(measurement.total - budget.total)} over budget`
    )
  }
  if (measurement.largest.gzipSize > budget.largest) {
    violations.push(
      `${kind.toUpperCase()} largest gzip chunk is ${formatBytes(measurement.largest.gzipSize - budget.largest)} over budget`
    )
  }
}

if (violations.length > 0) {
  console.error('\nDashboard bundle-size budget exceeded:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('\nDashboard bundle sizes are within budget.')
