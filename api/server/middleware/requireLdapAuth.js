const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const { toLogValue, formatLoginAttempt } = require('@librechat/api');

const requireLdapAuth = (req, res, next) => {
  passport.authenticate('ldapauth', (err, user, info) => {
    const attempt = { username: req.body?.email, ip: req.ip };
    if (err) {
      logger.error(
        `[Login] [Login failed] ${formatLoginAttempt(attempt)} [Reason: LDAP error]`,
        err,
      );
      return next(err);
    }
    if (!user) {
      logger.error(
        `[Login] [Login failed] ${formatLoginAttempt(attempt)} [Reason: ${toLogValue(info?.message)}]`,
      );
      return res.status(404).send(info);
    }
    logger.info(
      `[Login] [Login successful] ${formatLoginAttempt({ ...attempt, userId: user._id?.toString() })}`,
    );
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireLdapAuth;
