/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { assert } from '@japa/assert'
import { fileSystem } from '@japa/file-system'
import { expectTypeOf } from '@japa/expect-type'
import { processCLIArgs, configure, run } from '@japa/runner'

/*
|--------------------------------------------------------------------------
| Configure tests
|--------------------------------------------------------------------------
|
| The "processCLIArgs" call turns the command line arguments into a config
| object, which is then merged with the inline configuration below. CLI
| flags win.
|
*/
processCLIArgs(process.argv.slice(2))
configure({
  files: ['tests/**/*.spec.ts'],
  plugins: [
    assert(),
    expectTypeOf(),
    fileSystem({ basePath: new URL('../tests/tmp/', import.meta.url) }),
  ],
  forceExit: true,
})

/*
|--------------------------------------------------------------------------
| Run tests
|--------------------------------------------------------------------------
*/
run()
