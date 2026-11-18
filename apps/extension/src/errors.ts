export type ExtensionErrorKind =
  | "not_signed_in"
  | "scope_not_granted"
  | "auth_failed"
  | "gmail_error"
  | "gmail_rate_limited"
  | "proxy_unreachable"
  | "proxy_error"
  | "email_too_large";

export class ExtensionError extends Error {
  readonly kind: ExtensionErrorKind;

  constructor(kind: ExtensionErrorKind, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.kind = kind;
  }
}

/** Thrown by fetch wrappers when Google rejects the access token, so the caller can refresh it. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Access token rejected (HTTP 401)");
    this.name = "UnauthorizedError";
  }
}
