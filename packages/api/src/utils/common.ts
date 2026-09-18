import { AuthType } from 'librechat-data-provider';

/**
 * Checks if the given value is truthy by being either the boolean `true` or a string
 * that case-insensitively matches 'true'.
 *
 * @param value - The value to check.
 * @returns Returns `true` if the value is the boolean `true` or a case-insensitive
 *                    match for the string 'true', otherwise returns `false`.
 * @example
 *
 * isEnabled("True");  // returns true
 * isEnabled("TRUE");  // returns true
 * isEnabled(true);    // returns true
 * isEnabled("false"); // returns false
 * isEnabled(false);   // returns false
 * isEnabled(null);    // returns false
 * isEnabled();        // returns false
 */
export function isEnabled(value?: string | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase().trim() === 'true';
  }
  return false;
}

/**
 * Checks if the provided value is 'user_provided'.
 *
 * @param value - The value to check.
 * @returns - Returns true if the value is 'user_provided', otherwise false.
 */
export const isUserProvided = (value?: string): boolean => value === AuthType.USER_PROVIDED;

/**
 * Parses a value that may have arrived as a JSON-encoded array/object string
 * instead of already-structured data — local models regularly stringify a
 * nested field on its own. Only attempts the parse when the trimmed string
 * looks like `[...]` or `{...}`, so free-text values that happen to be valid
 * JSON primitives (e.g. a bullet reading "42" or "true") are never coerced.
 * Anything else, or a failed parse, comes back unchanged.
 */
export function parseIfJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * @param values
 */
export function optionalChainWithEmptyCheck(
  ...values: (string | number | undefined)[]
): string | number | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return values[values.length - 1];
}
