import { Data } from "effect";

/**
 * Why authentication failed. Distinct reasons so callers can branch without
 * parsing messages:
 *
 * - `invalid-credentials` — wrong username/password or db.
 * - `mfa-pending` — credentials accepted but a second factor is required
 *   before a usable session exists.
 * - `api-key-expired-or-invalid` — the API key was rejected.
 * - `totp-rpc-password` — hint: this account has 2FA enabled, so its login
 *   password cannot be used for RPC; an API key (used as the password) is
 *   required instead.
 */
export type OdooAuthReason =
  | "invalid-credentials"
  | "mfa-pending"
  | "api-key-expired-or-invalid"
  | "totp-rpc-password";

/**
 * Authentication did not yield a usable session. Carries a structured
 * {@link OdooAuthReason} rather than a free-text message.
 */
export class OdooAuthenticationError extends Data.TaggedError("OdooAuthenticationError")<{
  readonly reason: OdooAuthReason;
  readonly message: string;
}> {}
