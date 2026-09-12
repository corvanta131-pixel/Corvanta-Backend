const express = require("express");
const {
  listIdentities,
  getIdentity,
  createIdentity,
  updateIdentity,
  deleteIdentity,
} = require("../controllers/customerIdentityController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("customer-identities:read"), listIdentities);
router.post("/", requiresPermission("customer-identities:create"), createIdentity);
router.get("/:id", requiresPermission("customer-identities:read"), getIdentity);
router.patch("/:id", requiresPermission("customer-identities:update"), updateIdentity);
router.delete("/:id", requiresPermission("customer-identities:delete"), deleteIdentity);

module.exports = router;