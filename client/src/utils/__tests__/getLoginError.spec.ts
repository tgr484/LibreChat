import getLoginError from '../getLoginError';

describe('getLoginError', () => {
  test.each([
    ['Request failed with status code 429', 'com_auth_error_login_rl'],
    ['Request failed with status code 403', 'com_auth_error_login_ban'],
    ['Request failed with status code 500', 'com_auth_error_login_server'],
  ])('maps "%s" to %s regardless of the login method', (errorText, expected) => {
    expect(getLoginError(errorText)).toBe(expected);
    expect(getLoginError(errorText, true)).toBe(expected);
  });

  test('names bad credentials for an LDAP rejection', () => {
    expect(getLoginError('Request failed with status code 404', true)).toBe(
      'com_auth_error_login_ldap',
    );
  });

  test('keeps the generic message for email login', () => {
    expect(getLoginError('Request failed with status code 404')).toBe('com_auth_error_login');
  });
});
