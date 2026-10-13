const express = require("express");
const { listAuditLogs } = require("../controllers/auditController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("audit:read"), listAuditLogs);

module.exports = router;
