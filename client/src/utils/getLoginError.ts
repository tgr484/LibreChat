import { TranslationKeys } from '~/hooks';

/** LDAP rejects bad credentials with a bare status code, so its fallback names the likely cause. */
const getLoginError = (errorText: string, isLdapLogin = false): TranslationKeys => {
  const defaultError: TranslationKeys = isLdapLogin
    ? 'com_auth_error_login_ldap'
    : 'com_auth_error_login';

  if (!errorText) {
    return defaultError;
  }

  switch (true) {
    case errorText.includes('429'):
      return 'com_auth_error_login_rl';
    case errorText.includes('403'):
      return 'com_auth_error_login_ban';
    case errorText.includes('500'):
      return 'com_auth_error_login_server';
    case errorText.includes('422'):
      return 'com_auth_error_login_unverified';
    default:
      return defaultError;
  }
};

export default getLoginError;
