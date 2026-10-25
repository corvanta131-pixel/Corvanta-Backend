const express = require("express");
const { verifyChallenge, receive } = require("../controllers/connectorController");

const router = express.Router();

// Public: authenticated by the provider's signature (or, for Meta's GET check, the verify token).
// The :webhookKey is a server-generated identifier; it can never select another company's channel.
router.get("/:webhookKey", verifyChallenge);
router.post("/:webhookKey", receive);

module.exports = router;
