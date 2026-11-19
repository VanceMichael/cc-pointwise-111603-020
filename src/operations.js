import { buildBoard } from './board.js';

/**
 * Business read entry point.
 *
 * Default: the current projection.  `asOf`: rebuild the board from the
 * observations that had been *received* by that moment, so a shift handover
 * reflects what was known then instead of being replaced by today's page.
 * `reviews` carries the manual-check prompts; this function never edits or
 * merges the source plans.
 */
export async function readOperations(repository, { asOf } = {}) {
  const state = await repository.readState();
  return buildBoard(state.observations, { asOf, links: state.identity });
}
