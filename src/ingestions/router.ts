// /v1 ingestion routes: accept data durably (202), read a request's status,
// list a bank's history. Paths are relative to the /v1 prefix; mount with
// `app.route('/v1', createIngestionsRouter(store, registry))`.
// Request/response contract: docs/api/ingestions.md.

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { ApiError, errorEnvelope } from '../banks/errors.ts';
import { assertBankId, type BankLifecycleGuard } from '../banks/registry.ts';
import {
  INGESTION_STATUSES,
  isIngestionId,
  type IngestionStatus,
  type IngestionStore,
  type NewItem,
} from './store.ts';

export const MAX_BODY_BYTES = 50 * 1024 * 1024;
export const MAX_ITEMS = 100;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_METADATA_BYTES = 16 * 1024;
export const MAX_URL_LENGTH = 2048;
export const MAX_FILENAME_LENGTH = 200;
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

const JSON_KEYS = new Set(['items', 'metadata']);
const TEXT_ITEM_KEYS = new Set(['type', 'text', 'filename', 'mediaType', 'metadata']);
const URL_ITEM_KEYS = new Set(['type', 'url', 'filename', 'metadata']);
const MULTIPART_FIELDS = new Set(['file', 'text', 'url', 'metadata']);
const STATUS_FILTERS: readonly (IngestionStatus | 'all')[] = [...INGESTION_STATUSES, 'all'];
// Visible ASCII, as most Idempotency-Key implementations accept.
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
const MEDIA_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export function createIngestionsRouter(store: IngestionStore, banks: BankLifecycleGuard): Hono {
  const router = new Hono();

  router.post(
    '/banks/:bank/ingestions',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          errorEnvelope(new ApiError('payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes`)),
          413,
        ),
    }),
    (c) =>
      handle(c, async () => {
        const bank = param(c);
        const idempotencyKey = readIdempotencyKey(c);
        // Fail fast before reading a large body; accept() re-checks under the lifecycle lock.
        const state = await banks.lookup(bank);
        if (state === 'missing') throw new ApiError('bank_not_found', `Bank "${bank}" not found`, { bank });
        if (state !== 'active') {
          throw new ApiError(
            state === 'archiving' ? 'bank_archiving' : 'bank_archived',
            `Bank "${bank}" is ${state} and does not accept new work`,
            { bank, status: state },
          );
        }
        const { items, metadata } = await readPayload(c);
        const { record, replayed } = await store.accept({ bank, items, metadata, idempotencyKey });
        const statusUrl = `/v1/banks/${bank}/ingestions/${record.id}`;
        c.header('Location', statusUrl);
        if (replayed) c.header('Idempotent-Replayed', 'true');
        return c.json({ id: record.id, status: record.status, status_url: statusUrl }, 202);
      }),
  );

  router.get('/banks/:bank/ingestions', (c) =>
    handle(c, async () => {
      const bank = param(c);
      await requireBank(banks, bank);
      const status = (c.req.query('status') ?? 'all') as IngestionStatus | 'all';
      if (!STATUS_FILTERS.includes(status)) {
        throw new ApiError('validation_error', `status must be one of ${STATUS_FILTERS.join(', ')}`, {
          field: 'status',
        });
      }
      const limitRaw = c.req.query('limit');
      const limit = limitRaw === undefined ? LIST_LIMIT_DEFAULT : Number(limitRaw);
      if (!/^\d+$/.test(limitRaw ?? '1') || !Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
        throw new ApiError('validation_error', `limit must be an integer 1-${LIST_LIMIT_MAX}`, { field: 'limit' });
      }
      const cursor = c.req.query('cursor');
      const before = cursor === undefined ? undefined : decodeCursor(cursor, bank, status);
      const { ingestions, nextBefore } = await store.list(bank, { status, limit, before });
      return c.json({
        ingestions,
        nextCursor: nextBefore === null ? null : encodeCursor(nextBefore, bank, status),
      });
    }),
  );

  router.get('/banks/:bank/ingestions/:id', (c) =>
    handle(c, async () => {
      const bank = param(c);
      await requireBank(banks, bank);
      const id = c.req.param('id');
      const record = isIngestionId(id) ? await store.get(bank, id) : null;
      if (!record) {
        throw new ApiError('ingestion_not_found', `Ingestion "${id.slice(0, 100)}" not found in bank "${bank}"`, {
          bank,
          id: id.slice(0, 100),
        });
      }
      return c.json(record);
    }),
  );

  return router;
}

async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return c.json(errorEnvelope(err), err.status);
    console.error(err);
    return c.json(errorEnvelope(new ApiError('internal_error', 'Internal error')), 500);
  }
}

function param(c: Context): string {
  const bank = c.req.param('bank');
  assertBankId(bank);
  return bank;
}

/** History stays readable for archiving/archived banks; only a missing bank is 404. */
async function requireBank(banks: BankLifecycleGuard, bank: string): Promise<void> {
  if ((await banks.lookup(bank)) === 'missing') {
    throw new ApiError('bank_not_found', `Bank "${bank}" not found`, { bank });
  }
}

function readIdempotencyKey(c: Context): string | null {
  const key = c.req.header('Idempotency-Key');
  if (key === undefined) return null;
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ApiError('validation_error', 'Idempotency-Key must be 1-255 visible ASCII characters', {
      field: 'Idempotency-Key',
    });
  }
  return key;
}

// ---- payload parsing ----------------------------------------------------------

interface Payload {
  items: NewItem[];
  metadata: Record<string, unknown> | null;
}

async function readPayload(c: Context): Promise<Payload> {
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') return readJsonPayload(c);
  if (type === 'multipart/form-data') return readMultipartPayload(c);
  throw new ApiError('unsupported_media_type', 'Content-Type must be application/json or multipart/form-data', {
    contentType: type || null,
  });
}

async function readJsonPayload(c: Context): Promise<Payload> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError('invalid_json', 'Request body must be a JSON object');
  }
  if (!isPlainObject(body)) throw new ApiError('invalid_json', 'Request body must be a JSON object');
  rejectUnknown(body, JSON_KEYS, '');
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw invalid('items', 'items must be a non-empty array');
  }
  if (body.items.length > MAX_ITEMS) throw invalid('items', `items may hold at most ${MAX_ITEMS} entries`);
  const items = body.items.map((raw, i) => readJsonItem(raw, i));
  return { items, metadata: readMetadata(body.metadata, 'metadata') };
}

function readJsonItem(raw: unknown, i: number): NewItem {
  const at = `items[${i}]`;
  if (!isPlainObject(raw)) throw invalid(at, `${at} must be an object`);
  if (raw.type === 'text') {
    rejectUnknown(raw, TEXT_ITEM_KEYS, `${at}.`);
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      throw invalid(`${at}.text`, `${at}.text must be a non-empty string`);
    }
    const bytes = Buffer.from(raw.text, 'utf8');
    if (bytes.length > MAX_TEXT_BYTES) throw invalid(`${at}.text`, `${at}.text exceeds ${MAX_TEXT_BYTES} bytes`);
    return {
      kind: 'text',
      bytes,
      filename: readFilename(raw.filename, `${at}.filename`),
      mediaType: readMediaType(raw.mediaType, `${at}.mediaType`) ?? 'text/plain',
      metadata: readMetadata(raw.metadata, `${at}.metadata`),
    };
  }
  if (raw.type === 'url') {
    rejectUnknown(raw, URL_ITEM_KEYS, `${at}.`);
    return {
      kind: 'url',
      url: readUrl(raw.url, `${at}.url`),
      filename: readFilename(raw.filename, `${at}.filename`),
      metadata: readMetadata(raw.metadata, `${at}.metadata`),
    };
  }
  throw invalid(`${at}.type`, `${at}.type must be "text" or "url" (send files as multipart/form-data)`);
}

async function readMultipartPayload(c: Context): Promise<Payload> {
  let form: Record<string, unknown>;
  try {
    form = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  } catch {
    throw new ApiError('validation_error', 'Malformed multipart/form-data body');
  }
  const unknown = Object.keys(form).filter((k) => !MULTIPART_FIELDS.has(k));
  if (unknown.length) {
    throw new ApiError('validation_error', `Unknown multipart field(s): ${unknown.join(', ')}`, { fields: unknown });
  }
  const all = (name: string): unknown[] => {
    const v = form[name];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };

  const items: NewItem[] = [];
  for (const [i, part] of all('file').entries()) {
    if (!(part instanceof File)) throw invalid(`file[${i}]`, 'file parts must be file uploads');
    if (part.size === 0) throw invalid(`file[${i}]`, `file "${part.name}" is empty`);
    if (part.size > MAX_FILE_BYTES) throw invalid(`file[${i}]`, `file "${part.name}" exceeds ${MAX_FILE_BYTES} bytes`);
    items.push({
      kind: 'file',
      bytes: Buffer.from(await part.arrayBuffer()),
      filename: sanitizeFilename(part.name),
      mediaType: MEDIA_TYPE_RE.test(part.type) ? part.type.toLowerCase() : 'application/octet-stream',
    });
  }
  for (const [i, part] of all('text').entries()) {
    if (typeof part !== 'string' || part.length === 0) throw invalid(`text[${i}]`, 'text parts must be non-empty strings');
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length > MAX_TEXT_BYTES) throw invalid(`text[${i}]`, `text exceeds ${MAX_TEXT_BYTES} bytes`);
    items.push({ kind: 'text', bytes, mediaType: 'text/plain' });
  }
  for (const [i, part] of all('url').entries()) {
    if (typeof part !== 'string') throw invalid(`url[${i}]`, 'url parts must be strings');
    items.push({ kind: 'url', url: readUrl(part, `url[${i}]`) });
  }
  if (items.length === 0) throw invalid('file', 'Provide at least one file, text or url part');
  if (items.length > MAX_ITEMS) throw invalid('file', `At most ${MAX_ITEMS} items per request`);

  const metaParts = all('metadata');
  if (metaParts.length > 1) throw invalid('metadata', 'metadata may be sent once');
  let metadata: Record<string, unknown> | null = null;
  if (metaParts.length === 1) {
    if (typeof metaParts[0] !== 'string') throw invalid('metadata', 'metadata must be a JSON object string');
    let parsed: unknown;
    try {
      parsed = JSON.parse(metaParts[0]);
    } catch {
      throw invalid('metadata', 'metadata must be a JSON object string');
    }
    metadata = readMetadata(parsed, 'metadata');
  }
  return { items, metadata };
}

// ---- field validators -----------------------------------------------------------

function readMetadata(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw invalid(field, `${field} must be a JSON object`);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_METADATA_BYTES) {
    throw invalid(field, `${field} exceeds ${MAX_METADATA_BYTES} bytes as JSON`);
  }
  return value;
}

function readUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw invalid(field, `${field} must be an http(s) URL of at most ${MAX_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(field, `${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid(field, `${field} must use http or https`);
  }
  if (url.username || url.password) throw invalid(field, `${field} must not carry credentials`);
  return url.toString();
}

// eslint-disable-next-line no-control-regex
const FILENAME_BAD = /[\u0000-\u001f\u007f/\\]/;

function readFilename(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > MAX_FILENAME_LENGTH ||
    FILENAME_BAD.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw invalid(field, `${field} must be a plain file name of 1-${MAX_FILENAME_LENGTH} characters, no path`);
  }
  return value;
}

/** Browser-supplied names are not under the client's control: clean instead of rejecting. */
function sanitizeFilename(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..') return null;
  return base.slice(0, MAX_FILENAME_LENGTH);
}

function readMediaType(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !MEDIA_TYPE_RE.test(value)) {
    throw invalid(field, `${field} must be a media type like text/markdown`);
  }
  return value.toLowerCase();
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, prefix: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const fields = unknown.map((k) => `${prefix}${k}`);
    throw new ApiError('validation_error', `Unknown field(s): ${fields.join(', ')}`, { fields });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string, message: string): ApiError {
  return new ApiError('validation_error', message, { field });
}

// Cursor = base64url of {"before": <last id>, "bank", "status"}. Opaque; bound to bank + filter.
function encodeCursor(before: string, bank: string, status: string): string {
  return Buffer.from(JSON.stringify({ before, bank, status })).toString('base64url');
}

function decodeCursor(cursor: string, bank: string, status: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed?.bank === bank && parsed?.status === status && isIngestionId(parsed?.before)) return parsed.before;
  } catch {
    // fall through
  }
  throw new ApiError('invalid_cursor', 'cursor is malformed or belongs to a different bank or status filter');
}
