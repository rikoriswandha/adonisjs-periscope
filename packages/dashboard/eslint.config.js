import { configPkg } from '@adonisjs/eslint-config'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * `@adonisjs/eslint-config/react` is not usable here: it pulls in `eslint-plugin-react`,
 * whose latest release (7.37.5) declares a peer range topping out at ESLint 9 and therefore
 * cannot be installed alongside the ESLint 10 used across this monorepo. The rules that
 * actually matter for a Vite SPA live in `eslint-plugin-react-hooks`, which does support
 * ESLint 10, so those are applied directly. Revisit when eslint-plugin-react ships ESLint 10
 * support (dashboard UI work starts in Phase 4).
 */
const SOURCE_FILES = ['src/**/*.{ts,tsx}']

export default configPkg({
  ...reactHooks.configs.flat['recommended-latest'],
  files: SOURCE_FILES,
})
