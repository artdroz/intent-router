import { ZodError } from "zod";

/**
 * Stable machine-readable error codes shared by every entry point.
 */
export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "internal_error";

/**
 * Base class for all errors that should be mapped to an HTTP response.
 *
 * Service code throws a subclass; the transport layer normalizes and formats
 * it. `code` is stable and lane-independent; `statusCode` is the default HTTP
 * status for the REST lane (the OpenAI lane derives its own envelope).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(message: string, statusCode: number, code: ErrorCode, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** 400 — malformed input, Zod failures, or invalid business input. */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "validation_error", details);
  }
}

/** 401 — missing, invalid, disabled, or expired credentials. */
export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(message, 401, "unauthorized");
  }
}

/** 403 — authenticated, but the action is not allowed on the resource. */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403, "forbidden");
  }
}

/** 404 — referenced resource does not exist or is not visible to the tenant. */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, "not_found");
  }
}

/** 409 — state conflict: duplicate label, name reuse, invariant violation. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "conflict");
  }
}

/** 502 — an upstream embedding/LLM call failed, returned a malformed body, or timed out. */
export class UpstreamError extends AppError {
  constructor(message: string) {
    super(message, 502, "upstream_error");
  }
}

/** 500 — unhandled programmer errors and "should not happen" cases. */
export class InternalError extends AppError {
  constructor(message: string) {
    super(message, 500, "internal_error");
  }
}

/**
 * Normalize any thrown value into an {@link AppError}.
 *
 * This is the only place that inspects error internals. Fastify-level errors
 * (e.g. a malformed JSON body, rejected before our Zod schemas run) carry a
 * `statusCode` and are passed through with that status preserved.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new ValidationError("Request validation failed", err.issues);
  }

  const maybeFastify = err as { statusCode?: unknown; message?: unknown } | null;
  if (
    maybeFastify &&
    typeof maybeFastify.statusCode === "number" &&
    maybeFastify.statusCode >= 400 &&
    maybeFastify.statusCode < 600
  ) {
    return new AppError(
      typeof maybeFastify.message === "string" ? maybeFastify.message : "Request failed",
      maybeFastify.statusCode,
      statusToCode(maybeFastify.statusCode),
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return new InternalError(message);
}

/** REST lane error body: `{ error, details? }`. */
export function restErrorBody(err: AppError): { error: string; details?: unknown } {
  const masked = err.statusCode >= 500 ? "Internal server error" : err.message;
  return {
    error: masked,
    ...(err.details !== undefined ? { details: err.details } : {}),
  };
}

/** OpenAI lane error envelope: `{ error: { message, type, code } }`. */
export function openaiErrorBody(err: AppError): {
  error: { message: string; type: string; code: number };
} {
  return {
    error: {
      message: err.statusCode >= 500 ? "Internal server error" : err.message,
      type: openaiType(err.statusCode),
      code: err.statusCode,
    },
  };
}

function statusToCode(status: number): ErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "internal_error";
  return "validation_error";
}

function openaiType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}
