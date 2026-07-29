#!/usr/bin/env node

/**
 * Thin release-it launcher that can disable npm provenance.
 *
 * `packages/periscope/package.json` defaults `publishConfig.provenance` to true for
 * npmjs. Registries without OIDC provenance (e.g. Verdaccio) need an explicit CLI
 * override because `publishConfig` wins over plain env alone:
 *
 *   NPM_CONFIG_PROVENANCE=false npm run release
 *   PROVENANCE=false npm run release:dry
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const raw = process.env.NPM_CONFIG_PROVENANCE ?? process.env.PROVENANCE ?? 'true'
const provenance = !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase())

const args = [
  '-w',
  '@rikology/adonisjs-periscope',
  'exec',
  '--',
  'release-it',
  ...process.argv.slice(2),
]

if (!provenance) {
  args.push('--npm.publishArgs=--provenance=false')
}

const result = spawnSync('npm', args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NPM_CONFIG_PROVENANCE: provenance ? 'true' : 'false',
  },
})

process.exit(result.status ?? 1)
