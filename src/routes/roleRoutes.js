const express = require("express");
const { listRoles } = require("../controllers/roleController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("roles:read"), listRoles);

module.exports = router;
