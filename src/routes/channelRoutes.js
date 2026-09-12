const express = require("express");
const {
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  connectChannel,
  disconnectChannel,
  getConnectionStatus,
  retryChannelConnection,
} = require("../controllers/channelController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("channels:read"), listChannels);
router.post("/", requiresPermission("channels:create"), createChannel);
router.get("/:id", requiresPermission("channels:read"), getChannel);
router.patch("/:id", requiresPermission("channels:update"), updateChannel);
router.delete("/:id", requiresPermission("channels:delete"), deleteChannel);
router.post("/:id/connect", requiresPermission("channels:update"), connectChannel);
router.post("/:id/disconnect", requiresPermission("channels:update"), disconnectChannel);
router.get("/:id/connection", requiresPermission("channels:read"), getConnectionStatus);
router.post("/:id/retry", requiresPermission("channels:update"), retryChannelConnection);

module.exports = router;