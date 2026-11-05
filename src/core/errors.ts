/** Canonical OpenSMM error codes (spec/v0 §5). Transport adapters map httpStatus. */

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "SERVICE_UNAVAILABLE",
  "QUOTE_EXPIRED",
  "QUOTE_MISMATCH",
  "PAYMENT_REQUIRED",
  "SETTLEMENT_PENDING",
  "SUBMISSION_UNKNOWN",
  "PROVIDER_REJECTED",
  "POLICY_DENIED",
  "IDEMPOTENCY_CONFLICT",
  "REFUND_REQUIRED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 409,
  QUOTE_EXPIRED: 409,
  QUOTE_MISMATCH: 409,
  PAYMENT_REQUIRED: 402,
  SETTLEMENT_PENDING: 409,
  SUBMISSION_UNKNOWN: 502,
  PROVIDER_REJECTED: 502,
  POLICY_DENIED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  REFUND_REQUIRED: 500,
  INTERNAL: 500,
};

export class OpenSmmError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "OpenSmmError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function toErrorBody(err: unknown): {
  httpStatus: number;
  body: { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };
} {
  if (err instanceof OpenSmmError) {
    return { httpStatus: err.httpStatus, body: err.toBody() };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    httpStatus: 500,
    body: { error: { code: "INTERNAL", message } },
  };
}
