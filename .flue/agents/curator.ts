'use agent';
import { bash, useInitialData, useModel, useSandbox } from '@flue/runtime';
import * as v from 'valibot';
import roleDoc from '../roles/curator.md';
import { createBankBashFactory } from '../../src/bash-factory.js';
import { MODEL, THINKING_LEVEL } from '../../src/model.js';
import { roleInstructions } from '../../src/role.js';
import { useStructuredResult } from '../../src/structured-result.js';

export const CuratorResultSchema = v.object({
  summary: v.string(),
});

export const CuratorInitSchema = v.object({
  bank: v.string(),
  fsPath: v.string(),
});

/**
 * Memory-bank curator. One instance per request: the HTTP route
 * (src/curator.ts) ingests items, creates the instance with the bank as
 * initialData, sends the briefing, then sweeps and commits around it.
 */
export function Curator() {
  const { bank, fsPath } = useInitialData<v.InferOutput<typeof CuratorInitSchema>>();
  useModel(MODEL, { thinkingLevel: THINKING_LEVEL });
  useSandbox(bash(createBankBashFactory({ bank, bankFsPath: fsPath })));
  useStructuredResult(CuratorResultSchema);
  return roleInstructions(roleDoc);
}

Curator.agentName = 'curator';
Curator.initialData = CuratorInitSchema;
