/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { configPkg } from '@adonisjs/eslint-config'

/**
 * Enforcement of implementation plan §0, invariant 3:
 *
 *   "No outbound network calls anywhere in the package (lint rule banning `fetch`/`http.request`
 *    outside the HttpClientWatcher's *subscription* code)."
 *
 * Periscope observes the host application; it never phones home, never fetches remote assets and
 * never proxies traffic. The only carve-out is `src/watchers/http_client/**`, which subscribes to
 * `diagnostics_channel` events emitted by undici — it observes requests, it never makes them.
 */
const NETWORK_BAN_MESSAGE =
  'Outbound network access is banned in Periscope (implementation plan §0, invariant 3). ' +
  'Only src/watchers/http_client/** may reference network modules, and only to subscribe to ' +
  'diagnostics_channel events.'

const BANNED_NETWORK_MODULES = [
  'node:http',
  'node:https',
  'http',
  'https',
  'axios',
  'got',
  'node-fetch',
  'undici',
]

export default configPkg(
  {
    name: 'periscope/no-outbound-network',
    files: ['src/**/*.ts', 'providers/**/*.ts', 'commands/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: NETWORK_BAN_MESSAGE }],
      'no-restricted-imports': [
        'error',
        {
          paths: BANNED_NETWORK_MODULES.map((name) => ({ name, message: NETWORK_BAN_MESSAGE })),
        },
      ],
    },
  },
  {
    name: 'periscope/no-outbound-network-http-client-carve-out',
    files: ['src/watchers/http_client/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  }
)
