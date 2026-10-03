'use agent';
import { bash, useInitialData, useModel, useSandbox } from '@flue/runtime';
import * as v from 'valibot';
import roleDoc from '../roles/retriever.md';
import { createBankBashFactory } from '../../src/bash-factory.js';
import { MODEL, RETRIEVER_THINKING_LEVEL } from '../../src/model.js';
import { roleInstructions } from '../../src/role.js';
import { useStructuredResult } from '../../src/structured-result.js';

export const RetrieverResultSchema = v.object({
  answer: v.string(),
  references: v.array(
    v.object({
      path: v.string(),
      why: v.string(),
    }),
  ),
});

export const RetrieverInitSchema = v.object({
  bank: v.string(),
  fsPath: v.string(),
});

/**
 * Read-only memory-bank retriever. One instance per request: the HTTP route
 * (src/retriever.ts) creates it with the bank as initialData, sends the
 * briefing, and reads the structured `{ answer, references }` result back.
 */
export function Retriever() {
  const { bank, fsPath } = useInitialData<v.InferOutput<typeof RetrieverInitSchema>>();
  useModel(MODEL, { thinkingLevel: RETRIEVER_THINKING_LEVEL });
  useSandbox(bash(createBankBashFactory({ bank, bankFsPath: fsPath })));
  useStructuredResult(RetrieverResultSchema);
  return roleInstructions(roleDoc);
}

Retriever.agentName = 'retriever';
Retriever.initialData = RetrieverInitSchema;
