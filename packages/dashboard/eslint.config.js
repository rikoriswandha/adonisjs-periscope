import { configPkg } from '@adonisjs/eslint-config'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * `@adonisjs/eslint-config/react` is not usable here: it pulls in `eslint-plugin-react`,
 * whose latest release (7.37.5) declares a peer range topping out at ESLint 9 and therefore
 * cannot be installed alongside the ESLint 10 used across this monorepo. The rules that
 * actually matter for a Vite SPA live in `eslint-plugin-react-hooks`, which does support
 * ESLint 10, so those are applied directly. Revisit when eslint-plugin-react ships ESLint 10
 * support (the dashboard UI applies the rules directly).
 */
const SOURCE_FILES = ['src/**/*.{ts,tsx}']

export default configPkg(
  {
    name: 'dashboard/vendor-ignores',
    ignores: ['src/components/charts/**'],
  },
  {
    ...reactHooks.configs.flat['recommended-latest'],
    files: SOURCE_FILES,
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      /**
       * The polling hooks intentionally use refs as generation tokens during render so an
       * already-resolving request cannot publish stale rows in the render-to-effect window.
       * Effects also reset dependent UI state while starting the replacement request.
       */
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      /**
       * React components and hooks follow the established kebab-case file convention.
       */
      '@unicorn/filename-case': 'off',
    },
  }
)
