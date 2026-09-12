const express = require("express");
const { sendOutbound } = require("../controllers/outboundController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.post("/send", requiresPermission("messages:send"), sendOutbound);

module.exports = router;
