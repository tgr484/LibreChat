const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { formatLoginAttempt } = require('@librechat/api');
const {
  verifyTOTP,
  getTOTPSecret,
  verifyBackupCode,
} = require('~/server/services/twoFactorService');
const { setAuthTokens } = require('~/server/services/AuthService');
const { getUserById } = require('~/models');

const describe2FAFailure = (token, backupCode) => {
  if (token) {
    return 'invalid code';
  }
  return backupCode ? 'invalid backup code' : 'no code provided';
};

/**
 * Verifies the 2FA code during login using a temporary token.
 */
const verify2FAWithTempToken = async (req, res) => {
  try {
    const { tempToken, token, backupCode } = req.body;
    if (!tempToken) {
      return res.status(400).json({ message: 'Missing temporary token' });
    }

    let payload;
    try {
      payload = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch (err) {
      logger.error(
        `[Login] [2FA failed] ${formatLoginAttempt({ ip: req.ip })} [Reason: invalid or expired temporary token]`,
        err,
      );
      return res.status(401).json({ message: 'Invalid or expired temporary token' });
    }

    const user = await getUserById(payload.userId, '+totpSecret +backupCodes');
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ message: '2FA is not enabled for this user' });
    }

    const secret = await getTOTPSecret(user.totpSecret);
    let isVerified = false;
    if (token) {
      isVerified = await verifyTOTP(secret, token);
    } else if (backupCode) {
      isVerified = await verifyBackupCode({ user, backupCode });
    }

    const attempt = { username: user.email, ip: req.ip, userId: user._id.toString() };
    if (!isVerified) {
      logger.error(
        `[Login] [2FA failed] ${formatLoginAttempt(attempt)} [Reason: ${describe2FAFailure(token, backupCode)}]`,
      );
      return res.status(401).json({ message: 'Invalid 2FA code or backup code' });
    }

    const userData = user.toObject ? user.toObject() : { ...user };
    delete userData.__v;
    delete userData.password;
    delete userData.totpSecret;
    delete userData.backupCodes;
    userData.id = user._id.toString();

    const authToken = await setAuthTokens(user._id, res, null, req);
    logger.info(`[Login] [2FA successful] ${formatLoginAttempt(attempt)}`);
    return res.status(200).json({ token: authToken, user: userData });
  } catch (err) {
    logger.error('[verify2FAWithTempToken]', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

module.exports = { verify2FAWithTempToken };
