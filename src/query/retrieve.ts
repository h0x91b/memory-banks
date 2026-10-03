// Default RetrieveFn: the real retriever pipeline (prompt, telemetry, spend
// accounting) reading the snapshot while the model and the references only
// see the bank's real fs/ path. Kept out of ./index.ts so the query service
// and its tests do not load the Flue runtime.

import { runRetrieverAt } from '../retriever.js';
import type { RetrieveFn } from './service.ts';

export const retrieveFromSnapshot: RetrieveFn = async ({ bank, question, hint, readRoot, fsPath, runId }) => {
  // repoPath null: the live repo is the Librarian's, its changes are not ours.
  // The service measures writes on the snapshot itself.
  const { answer, references, meta } = await runRetrieverAt(
    { bank, question, hint, readRoot, fsPath, repoPath: null },
    runId,
  );
  const { unexpected_writes: _ignored, ...rest } = meta;
  return { answer, references, meta: rest };
};
