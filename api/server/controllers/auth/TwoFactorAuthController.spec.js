const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');

jest.mock('~/models', () => ({ getUserById: jest.fn() }));
jest.mock('~/server/services/AuthService', () => ({
  setAuthTokens: jest.fn().mockResolvedValue('auth-token'),
}));
jest.mock('~/server/services/twoFactorService', () => ({
  getTOTPSecret: jest.fn().mockResolvedValue('totp-secret'),
  verifyTOTP: jest.fn(),
  verifyBackupCode: jest.fn(),
}));

const { getUserById } = require('~/models');
const { verifyTOTP } = require('~/server/services/twoFactorService');
const { verify2FAWithTempToken } = require('./TwoFactorAuthController');

const JWT_SECRET = 'test-jwt-secret';
const user = { _id: 'u1', email: 'ivanov@rn-t.ru', twoFactorEnabled: true };

const callController = async (body) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await verify2FAWithTempToken({ body, ip: '10.0.0.5' }, res);
  return res;
};

describe('verify2FAWithTempToken login audit', () => {
  const originalSecret = process.env.JWT_SECRET;
  const tempToken = () => jwt.sign({ userId: user._id }, JWT_SECRET);
  let infoSpy;
  let errorSpy;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    getUserById.mockResolvedValue(user);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
    jest.restoreAllMocks();
  });

  it('logs a completed 2FA login', async () => {
    verifyTOTP.mockResolvedValue(true);

    const res = await callController({ tempToken: tempToken(), token: '123456' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(infoSpy).toHaveBeenCalledWith(
      '[Login] [2FA successful] [Username: ivanov@rn-t.ru] [User-ID: u1] [Request-IP: 10.0.0.5]',
    );
  });

  it('logs a wrong 2FA code without the code itself', async () => {
    verifyTOTP.mockResolvedValue(false);

    const res = await callController({ tempToken: tempToken(), token: '654321' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Login] [2FA failed] [Username: ivanov@rn-t.ru] [User-ID: u1] [Request-IP: 10.0.0.5] [Reason: invalid code]',
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('654321');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('logs a request without any code', async () => {
    const res = await callController({ tempToken: tempToken() });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[Reason: no code provided]'));
  });

  it('logs an invalid temporary token with the IP', async () => {
    const res = await callController({ tempToken: 'forged', token: '123456' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Login] [2FA failed] [Username: ] [Request-IP: 10.0.0.5] [Reason: invalid or expired temporary token]',
      expect.any(Error),
    );
  });
});
