import {
  useAgentFinish,
  useDataWriter,
  useInstruction,
  useResponseFinish,
  useTool,
  type AgentReply,
  type PromptUsage,
} from '@flue/runtime';
import * as v from 'valibot';

export const RESULT_TOOL = 'submit_result';
const RESULT_PART = 'result';

/**
 * Custom hook: make the agent deliver one validated structured result.
 *
 * The model calls `submit_result` with arguments matching `schema`; the tool
 * records them as the `result` data part and ends the turn. If the model tries
 * to stop without calling it, the finish hook sends it back to work. The final
 * usage aggregate and tool-call list are attached as response metadata so the
 * caller can report tokens, cost and bash-call counts.
 */
export interface StructuredResultOptions<T> {
  /**
   * Runs inside `submit_result` before the result is recorded. Return `null`
   * to accept; return a message to reject the call: the tool fails with that
   * message, nothing is recorded, and the finish hook keeps the agent working
   * so it can fix things and submit again.
   */
  gate?: (data: T) => Promise<string | null>;
}

export function useStructuredResult<TSchema extends v.ObjectSchema<v.ObjectEntries, undefined>>(
  schema: TSchema,
  options: StructuredResultOptions<v.InferOutput<TSchema>> = {},
): void {
  const writeResult = useDataWriter(RESULT_PART, { schema });

  useTool({
    name: RESULT_TOOL,
    description:
      'Submit your final structured result. Call exactly once, when all work is done; this ends your turn.',
    input: schema,
    async run({ data }) {
      const result = data as v.InferOutput<TSchema>;
      const rejection = options.gate ? await options.gate(result) : null;
      if (rejection !== null) throw new Error(rejection);
      writeResult(result);
      return { output: 'Result recorded.', terminate: true };
    },
  });

  useInstruction(
    `## Delivering the result\n\nDeliver the structured result described above by calling the \`${RESULT_TOOL}\` tool exactly once, with that object as its arguments. Do not print the JSON as plain text.`,
  );

  useAgentFinish(({ response, append }) => {
    const submitted = response.toolCalls.some((call) => call.tool === RESULT_TOOL && !call.isError);
    if (!submitted) {
      append({
        kind: 'signal',
        type: 'result-required',
        body: `You have not called \`${RESULT_TOOL}\` yet. Finish any remaining work, then call it with your final structured result.`,
      });
    }
  });

  useResponseFinish(({ response }) => ({
    usage: response.usage,
    toolCalls: response.toolCalls.map((call) => call.tool),
  }));
}

export interface StructuredReply<T> {
  data: T;
  usage: PromptUsage | null;
  toolCalls: string[];
}

/** Read the structured result and usage metadata back out of an agent reply. */
export function readStructuredReply<TSchema extends v.GenericSchema>(
  reply: AgentReply,
  schema: TSchema,
): StructuredReply<v.InferOutput<TSchema>> {
  const writes = reply.data[RESULT_PART] ?? [];
  if (writes.length === 0) {
    throw new Error(`Agent settled without calling ${RESULT_TOOL}`);
  }
  const data = v.parse(schema, writes[writes.length - 1]);
  const metadata = (reply.metadata ?? {}) as { usage?: PromptUsage; toolCalls?: string[] };
  return { data, usage: metadata.usage ?? null, toolCalls: metadata.toolCalls ?? [] };
}
