const passport = require('passport');
const { logger } = require('@librechat/data-schemas');

const MAX_LOGGED_LOGIN_LENGTH = 256;

/** Collapses control characters so a crafted login cannot forge extra log lines. */
const toLogValue = (value) =>
  String(value ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, MAX_LOGGED_LOGIN_LENGTH);

const describeAttempt = (req) =>
  `[Username: ${toLogValue(req.body?.email)}] [Request-IP: ${req.ip}]`;

const requireLdapAuth = (req, res, next) => {
  passport.authenticate('ldapauth', (err, user, info) => {
    if (err) {
      logger.error(`[Login] [Login failed] ${describeAttempt(req)} [Reason: LDAP error]`, err);
      return next(err);
    }
    if (!user) {
      logger.error(
        `[Login] [Login failed] ${describeAttempt(req)} [Reason: ${toLogValue(info?.message)}]`,
      );
      return res.status(404).send(info);
    }
    logger.info(`[Login] [Login successful] ${describeAttempt(req)}`);
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireLdapAuth;
