/** An OAuth 2.0 error response per RFC 6749 §5.2, carried as an exception. */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly description: string,
  ) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
  }

  static invalidClient(description: string): OAuthError {
    return new OAuthError(401, "invalid_client", description);
  }

  static invalidRequest(description: string): OAuthError {
    return new OAuthError(400, "invalid_request", description);
  }

  /**
   * The catch-all for a bad assertion. Deliberately uniform: a caller learns that the
   * ID-JAG was rejected, not which specific check caught it. The detail lives in the
   * server-side trace, where it belongs.
   */
  static invalidGrant(description: string): OAuthError {
    return new OAuthError(400, "invalid_grant", description);
  }

  static invalidScope(description: string): OAuthError {
    return new OAuthError(400, "invalid_scope", description);
  }

  static unsupportedGrantType(description: string): OAuthError {
    return new OAuthError(400, "unsupported_grant_type", description);
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
