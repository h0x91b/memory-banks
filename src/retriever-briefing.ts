export interface RetrieverBriefingInput {
  bank: string;
  question: string;
  /** Absolute host path of the bank's `fs/` root: the sandbox `/` and the citation prefix. */
  fsPath: string;
  hint?: string;
  /** `buildBankBriefing(fsPath, { role: 'retriever' }).text`: full root map, then the glossary. */
  bankBriefing: string;
}

/**
 * The retriever's first message. The bank briefing (root map + generated
 * glossary) is injected verbatim and in full; the role doc explains how to
 * navigate with it.
 */
export function buildRetrieverBriefing(input: RetrieverBriefingInput): string {
  const { bank, question, fsPath, hint, bankBriefing } = input;
  const parts: string[] = [];
  parts.push(`# Retrieve from memory bank \`${bank}\``);
  parts.push('');
  parts.push('## Question');
  parts.push(question);
  parts.push('');
  if (hint && hint.trim()) {
    parts.push('## Hint from the caller');
    parts.push(hint.trim());
    parts.push('');
  }
  parts.push('## Sandbox details');
  parts.push(
    `Your tools see the bank mounted at \`/\`. The absolute host path of that root is:\n\n\`${fsPath}\`\n\nUse this prefix when building absolute paths for \`references\`. **Do not run \`pwd\`** — the path above is authoritative.`,
  );
  parts.push('');
  parts.push('## Bank map and glossary (pre-loaded, complete)');
  parts.push(
    'Below is the root `/_index.md` in full — the bank overview and one line for every folder at every depth — followed by the glossary generated from the file manifests (`TERM — meaning (content file path)`). There are no other index files. Pick topics, folders and search terms from this before calling any tool.',
  );
  parts.push('');
  parts.push('<bank-briefing>');
  parts.push(bankBriefing.replace(/\n+$/, ''));
  parts.push('</bank-briefing>');
  parts.push('');
  parts.push('## Your job');
  parts.push(
    'Answer the question strictly from the bank\'s content files: choose folders and terms from the map and glossary, search with targeted `rg`, then read the primary files. Manifest and glossary hits are navigation only — confirm every fact in the content file itself. Cite every file you used in `references` with absolute paths. If nothing relevant exists in the bank, submit the exact "no data" answer described in your role instructions.',
  );
  parts.push('');
  parts.push(
    "**Write the `answer` field in English** — even if the question is in another language. A downstream agent will localize the final user-facing answer. Direct quotes from source files preserve their original language verbatim.",
  );
  parts.push('');
  parts.push('Do NOT modify the bank — reads, searches and listings only.');
  return parts.join('\n');
}
