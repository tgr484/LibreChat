import type { TDochubErrorCode } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

const ERROR_KEYS: Record<TDochubErrorCode, TranslationKeys> = {
  dochub_not_configured: 'com_ui_dochub_error_not_configured',
  dochub_not_ldap: 'com_ui_dochub_error_not_ldap',
  dochub_no_identity: 'com_ui_dochub_error_no_identity',
  dochub_collection_unavailable: 'com_ui_dochub_error_collection_unavailable',
  dochub_collection_private: 'com_ui_dochub_error_collection_private',
  dochub_collection_locked: 'com_ui_dochub_error_collection_locked',
  dochub_not_manager: 'com_ui_dochub_error_not_manager',
  dochub_publish_unsupported: 'com_ui_dochub_error_publish_unsupported',
  dochub_unavailable: 'com_ui_dochub_error_unavailable',
};

/** The DocHub error code a server response carries, if any. */
export function dochubErrorCode(error: unknown): TDochubErrorCode | undefined {
  const code = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data
    ?.error;
  return typeof code === 'string' && code in ERROR_KEYS ? (code as TDochubErrorCode) : undefined;
}

/** A localizable message for a failed DocHub call; unknown failures read as "unavailable". */
export function dochubErrorKey(error: unknown): TranslationKeys {
  return ERROR_KEYS[dochubErrorCode(error) ?? 'dochub_unavailable'];
}
