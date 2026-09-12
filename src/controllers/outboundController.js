const asyncHandler = require("../utils/asyncHandler");
const { sendOutboundMessage } = require("../services/outboundPipeline");
const { logAudit } = require("../services/auditService");

exports.sendOutbound = asyncHandler(async (req, res) => {
  const result = await sendOutboundMessage(req.body, {}, {
    companyId: req.companyId || req.user?.companyId,
    user: req.user || null,
  });

  await logAudit({
    user: req.user || null,
    companyId: req.companyId || req.user?.companyId,
    action: "channel.outbound.api.sent",
    entityType: "Message",
    entityId: String(result.message._id),
    metadata: {
      channelType: result.message.channelType,
      conversationId: String(result.conversation._id),
      deliveryStatus: result.message.deliveryStatus,
    },
  });

  res.status(result.duplicate ? 200 : 201).json({
    success: true,
    message: result.duplicate ? "Duplicate outbound message ignored." : "Outbound message queued.",
    data: {
      duplicate: result.duplicate,
      message: result.message,
      conversation: result.conversation,
      adapterResult: result.adapterResult,
    },
  });
});
