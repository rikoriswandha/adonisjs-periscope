/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Implemented in Phase 1 (P1.3 — recorder pipeline, `src/recorder/recorder.ts`). Phase 0 ships
 * the module so the package `exports` map resolves and `npm run build` produces every declared
 * entry point.
 *
 * This file is the container service behind the `periscope/services/recorder` subpath. P1.3
 * replaces the placeholder with the resolved singleton
 * (`await app.container.make('periscope.recorder')`) and fills the `Recorder` contract with
 * `record` / `flush` / `mute` / hook registration.
 */

/**
 * The recorder contract. Deliberately empty in Phase 0 — the real members land in P1.3 rather
 * than being guessed at here.
 */
export interface Recorder {}

const recorder: Recorder = {}

export default recorder
