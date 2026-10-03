// Shared error type and JSON envelope for the /v1 API.
//
// Every /v1 error response has the same shape:
//   { "error": { "code": "bank_not_found", "message": "...", "details"?: {...} } }
// `code` is stable and machine-readable; `message` is for humans and may change.

export type ApiErrorCode =
  | 'invalid_bank_id'
  | 'invalid_json'
  | 'validation_error'
  | 'invalid_cursor'
  | 'not_found'
  | 'bank_not_found'
  | 'bank_exists'
  | 'bank_archiving'
  | 'bank_archived'
  | 'ingestion_not_found'
  | 'idempotency_conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error';

export type ApiErrorStatus = 400 | 404 | 409 | 413 | 415 | 500;

const STATUS: Record<ApiErrorCode, ApiErrorStatus> = {
  invalid_bank_id: 400,
  invalid_json: 400,
  validation_error: 400,
  invalid_cursor: 400,
  not_found: 404,
  bank_not_found: 404,
  bank_exists: 409,
  bank_archiving: 409,
  bank_archived: 409,
  ingestion_not_found: 404,
  idempotency_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ApiErrorStatus;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export interface ErrorEnvelope {
  error: { code: ApiErrorCode; message: string; details?: Record<string, unknown> };
}

export function errorEnvelope(err: ApiError): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
