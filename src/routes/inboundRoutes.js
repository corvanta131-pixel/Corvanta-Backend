const express = require("express");
const { receiveInbound } = require("../controllers/inboundController");
const webhookAuth = require("../middleware/webhookAuth");

const router = express.Router();

// Webhook authentication replaces the normal JWT protect middleware.
// The :webhookPath segment is a server-assigned channel identifier that
// cannot be used to select another company's channel.
router.post("/:webhookPath", webhookAuth, receiveInbound);

module.exports = router;