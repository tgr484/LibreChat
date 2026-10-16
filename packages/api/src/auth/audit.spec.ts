import { formatLoginAttempt, toLogValue } from './audit';

describe('formatLoginAttempt', () => {
  it('formats the login and IP', () => {
    expect(formatLoginAttempt({ username: 'ivanov', ip: '10.0.0.5' })).toBe(
      '[Username: ivanov] [Request-IP: 10.0.0.5]',
    );
  });

  it('adds the user id once the account is known', () => {
    expect(formatLoginAttempt({ username: 'ivanov', ip: '10.0.0.5', userId: 'u1' })).toBe(
      '[Username: ivanov] [User-ID: u1] [Request-IP: 10.0.0.5]',
    );
  });

  it('keeps a missing login visible as empty', () => {
    expect(formatLoginAttempt({ ip: '10.0.0.5' })).toBe('[Username: ] [Request-IP: 10.0.0.5]');
  });
});

describe('toLogValue', () => {
  it('flattens control characters so a login cannot forge log lines', () => {
    expect(toLogValue('x\r\n2026-10-16 info: [Login] [Login successful]')).toBe(
      'x 2026-10-16 info: [Login] [Login successful]',
    );
  });

  it('caps the length', () => {
    expect(toLogValue('a'.repeat(1000))).toHaveLength(256);
  });
});
