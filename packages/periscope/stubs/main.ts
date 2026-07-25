/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Absolute path to the directory holding Periscope's `.stub` templates, as the AdonisJS codemods
 * API expects to receive it:
 *
 * ```ts
 * await codemods.makeUsingStub(stubsRoot, 'config/periscope.stub', {})
 * ```
 *
 * It resolves against the *compiled* location, which is why `package.json#copy:templates` copies
 * `stubs/**{'/'}*.stub` into `build/stubs/` preserving the directory — the templates have to sit
 * next to this module after a build, not somewhere a relative path happens to reach.
 */
export const stubsRoot = import.meta.dirname
