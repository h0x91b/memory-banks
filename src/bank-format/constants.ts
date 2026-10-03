// Limits and reserved names of the bank format, contract v1
// (docs/design/bank-format.md §10). Names match the contract; change a value
// only together with the contract.

export const MAX_DEPTH = 3;
export const WIDTH_TARGET = 10;
export const WIDTH_LIMIT = 20;
export const GLOSSARY_DESC_MAX = 100;
export const FOLDER_DESC_MAX = 200;
export const MAX_REJECTIONS = 3;
export const MANIFEST_SUFFIX = '.manifest.json';
export const TITLE_MAX = 120;
export const KEYWORDS_MAX = 30;
export const KEYWORD_MAX = 60;
export const GLOSSARY_ENTRIES_MAX = 20;
export const TERM_MAX = 40;
export const MANIFEST_MAX_BYTES = 8192;
export const OVERVIEW_MAX = 600;
export const MAP_MAX = 40_000;
export const GLOSSARY_BLOCK_MAX = 60_000;
export const REJECTION_LIST_MAX = 20;
/** Inbox folders, skipped entirely, recognised only directly under the bank root. */
export const INBOX_DIRS: readonly string[] = ['_raw', '_unsorted'];

// Names fixed by §2 and §5 that the contract does not list as constants.
export const ROOT_MAP_FILE = '_index.md';
export const OPEN_QUESTIONS_FILE = '_open-questions.md';
/** Root map title limit, code points (§5.1). */
export const MAP_TITLE_MAX = 80;
export const FOLDERS_HEADING = '## Folders';
/** Separator between path and description in a map line, and forbidden inside glossary terms. */
export const SEPARATOR = ' — ';
