const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const requireLdapAuth = require('./requireLdapAuth');

const useLdapOutcome = (outcome) =>
  passport.use('ldapauth', {
    name: 'ldapauth',
    authenticate() {
      outcome(this);
    },
  });

const runMiddleware = (body) =>
  new Promise((resolve) => {
    const req = { body, ip: '10.0.0.5' };
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(() => resolve({ req, res, next })),
    };
    const next = jest.fn(() => resolve({ req, res, next }));
    requireLdapAuth(req, res, next);
  });

describe('requireLdapAuth login audit', () => {
  let infoSpy;
  let errorSpy;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    passport.unuse('ldapauth');
  });

  it('logs a successful login with username and IP', async () => {
    const user = { _id: 'u1', email: 'ivanov@rn-t.ru' };
    useLdapOutcome((strategy) => strategy.success(user));

    const { req, next } = await runMiddleware({ email: 'ivanov', password: 'secret' });

    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledWith();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Login] [Login successful] [Username: ivanov] [User-ID: u1] [Request-IP: 10.0.0.5]',
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a rejected login with the reason and never the password', async () => {
    useLdapOutcome((strategy) => strategy.fail({ message: 'Invalid username/password' }, 401));

    const { res } = await runMiddleware({ email: 'ivanov', password: 'secret' });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Login] [Login failed] [Username: ivanov] [Request-IP: 10.0.0.5] [Reason: Invalid username/password]',
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('logs an LDAP error as a failed login and passes the error on', async () => {
    const ldapError = new Error('connect ECONNREFUSED');
    useLdapOutcome((strategy) => strategy.error(ldapError));

    const { next } = await runMiddleware({ email: 'ivanov', password: 'secret' });

    expect(next).toHaveBeenCalledWith(ldapError);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Login] [Login failed] [Username: ivanov] [Request-IP: 10.0.0.5] [Reason: LDAP error]',
      ldapError,
    );
  });

  it('flattens control characters so a login cannot forge log lines', async () => {
    useLdapOutcome((strategy) => strategy.fail({ message: 'Invalid username/password' }, 401));

    await runMiddleware({
      email: 'x\n2026-10-16 info: [Login] [Login successful] [Username: admin]',
      password: 'secret',
    });

    const [message] = errorSpy.mock.calls[0];
    expect(message).not.toContain('\n');
    expect(message).toContain('[Username: x 2026-10-16 info:');
  });
});
