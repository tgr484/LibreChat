const express = require('express');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  generateCheckAccess,
  listDochubCollectionsHandler,
  publishDochubCollectionHandler,
} = require('@librechat/api');
const { requireJwtAuth, checkBan, configMiddleware } = require('~/server/middleware');
const { getRoleByName } = require('~/models');

const router = express.Router();

const checkAgentCreate = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

router.use(requireJwtAuth, checkBan, checkAgentCreate, configMiddleware);

/**
 * Collections the user can build a DocHub agent on.
 * @route GET /api/dochub/collections
 */
router.get('/collections', listDochubCollectionsHandler);

/**
 * Makes a collection public in DocHub; `?dry_run=1` only reports what would change.
 * @route POST /api/dochub/collections/:id/publish
 */
router.post('/collections/:id/publish', publishDochubCollectionHandler);

module.exports = router;
