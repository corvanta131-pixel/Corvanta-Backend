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
const { getWidgetSettings, saveWidgetSettings } = require("../controllers/widgetController");
const { getConnector, saveConnector, testConnector, rotateSigningSecret, clearConnector } = require("../controllers/connectorController");
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
router.get("/:id/widget", requiresPermission("channels:read"), getWidgetSettings);
router.put("/:id/widget", requiresPermission("channels:update"), saveWidgetSettings);
router.get("/:id/connector", requiresPermission("channels:read"), getConnector);
router.put("/:id/connector", requiresPermission("channels:update"), saveConnector);
router.post("/:id/connector/test", requiresPermission("channels:update"), testConnector);
router.post("/:id/connector/signing-secret", requiresPermission("channels:update"), rotateSigningSecret);
router.delete("/:id/connector", requiresPermission("channels:update"), clearConnector);

module.exports = router;