const MAX_LOGGED_VALUE_LENGTH = 256;

export interface LoginAttempt {
  /** The login exactly as the client sent it, or the account's email once it is known. */
  username?: string | null;
  ip?: string;
  userId?: string;
}

/** Flattens control characters so a client-supplied login cannot forge extra log lines. */
export function toLogValue(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, MAX_LOGGED_VALUE_LENGTH);
}

/**
 * Formats the identifying tail of a `[Login]` audit line, shared by every login step
 * so one `grep '\[Login\]'` follows a user from password to 2FA.
 */
export function formatLoginAttempt({ username, ip, userId }: LoginAttempt): string {
  const userIdPart = userId ? ` [User-ID: ${userId}]` : '';
  return `[Username: ${toLogValue(username)}]${userIdPart} [Request-IP: ${ip ?? ''}]`;
}
