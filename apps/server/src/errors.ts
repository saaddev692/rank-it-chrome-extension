import type { ErrorCode } from "@oep/shared";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: 400 | 403 | 413 | 422 | 429 | 500 | 502 | 504;

  constructor(code: ErrorCode, status: AppError["status"], message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}
