'use agent';
import { bash, useInitialData, useModel, useSandbox } from '@flue/runtime';
import * as v from 'valibot';
import roleDoc from '../roles/librarian.md';
import { createBankBashFactory } from '../../src/bash-factory.js';
import { MODEL, LIBRARIAN_THINKING_LEVEL } from '../../src/model.js';
import { roleInstructions } from '../../src/role.js';
import { findGate } from '../../src/librarian-gate.js';
import { useStructuredResult } from '../../src/structured-result.js';

export const LibrarianResultSchema = v.object({
  summary: v.string(),
});

export const LibrarianInitSchema = v.object({
  bank: v.string(),
  fsPath: v.string(),
  /** Id of the host-registered submit gate (src/librarian-gate.ts); absent = ungated. */
  gateId: v.optional(v.string()),
});

/**
 * Memory-bank librarian (formerly "curator"). One instance per request: the
 * HTTP route (src/librarian.ts) ingests items, creates the instance with the
 * bank as initialData, sends the briefing, then sweeps and commits around it.
 * With a `gateId` in initialData, `submit_result` is gated by the bank
 * validator through the host's gate (src/librarian-gate.ts, contract §9).
 */
export function Librarian() {
  const { bank, fsPath, gateId } = useInitialData<v.InferOutput<typeof LibrarianInitSchema>>();
  useModel(MODEL, { thinkingLevel: LIBRARIAN_THINKING_LEVEL });
  useSandbox(bash(createBankBashFactory({ bank, bankFsPath: fsPath })));
  useStructuredResult(LibrarianResultSchema, {
    gate: gateId
      ? async () => {
          const gate = findGate(gateId);
          if (!gate) throw new Error(`submit gate ${gateId} is not registered`);
          const decision = await gate.check();
          return decision.accept ? null : decision.message;
        }
      : undefined,
  });
  return roleInstructions(roleDoc);
}

Librarian.agentName = 'librarian';
Librarian.initialData = LibrarianInitSchema;
