const asyncHandler = require("../utils/asyncHandler");
const { processInboundMessage } = require("../services/inboundPipeline");
const { logAudit } = require("../services/auditService");

/**
 * Inbound webhook controller.
 *
 * Thin wrapper: receives the validated webhook request, builds the normalized
 * payload/context, delegates to processInboundMessage(), and returns the
 * existing API response convention. All business logic lives in the pipeline
 * service; all error handling is centralized via AppError/errorHandler.
 */
exports.receiveInbound = asyncHandler(async (req, res) => {
  const channel = req.webhookChannel;
  const payload = { ...req.body, companyId: channel.companyId };

  const result = await processInboundMessage(payload, {
    defaultAgentId: payload.defaultAgentId || null,
    handlingMode: payload.handlingMode || "AI",
  });

  await logAudit({
    user: null,
    companyId: channel.companyId,
    action: "channel.inbound.received",
    entityType: "Message",
    entityId: result.message ? String(result.message._id) : "",
    metadata: {
      channelId: String(channel._id),
      channelType: channel.type,
      duplicate: result.duplicate,
      conversationId: result.conversation ? String(result.conversation._id) : null,
    },
  });

  res.status(200).json({
    success: true,
    message: result.duplicate ? "Duplicate message ignored." : "Message received.",
    data: {
      duplicate: result.duplicate,
      message: result.message,
      conversation: result.conversation,
      customer: result.customer,
      aiResponse: result.aiResponse,
      workflowResult: result.workflowResult,
    },
  });
});