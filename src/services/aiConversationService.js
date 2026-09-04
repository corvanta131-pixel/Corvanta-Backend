const Conversation = require("../models/Conversation");
const AIAgent = require("../models/AIAgent");
const Customer = require("../models/Customer");
const Message = require("../models/Message");
const AppError = require("../utils/AppError");
const config = require("../config/config");
const { validateObjectId } = require("../validators/commonValidator");
const { defaultAIService, AIProviderError } = require("./ai/aiService");
const { retrieveKnowledge } = require("./knowledgeRetriever");
const { buildContext } = require("./contextBuilder");
const { createMessage, publicMessage } = require("./messageService");
const { logAudit } = require("./auditService");

async function sendConversationMessage(companyId, conversationId, payload, actor, options = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  validateObjectId(conversationId, "conversationId");
  const conversation = await Conversation.findOne({
    _id: conversationId,
    companyId,
    isDeleted: false,
  });
  if (!conversation) throw new AppError(404, "Conversation not found.");

  if (conversation.customerId) {
    const customer = await Customer.findOne({ _id: conversation.customerId, companyId, isDeleted: false }).select("_id").lean();
    if (!customer) throw new AppError(403, "Conversation customer is unavailable.");
  }

  const agent = await AIAgent.findOne({
    _id: conversation.agentId,
    companyId,
    status: "active",
    isDeleted: false,
  }).lean();
  if (!agent) throw new AppError(409, "This conversation does not have an active AI agent.");
  if (agent.provider && agent.provider !== "mock" && !options.aiService) {
    throw new AppError(503, "The configured AI provider is unavailable.");
  }

  const historyLimit = Number(options.historyLimit || config.AI_HISTORY_MESSAGE_LIMIT);
  const history = await Message.find({ companyId, conversationId: conversation._id, isDeleted: false })
    .sort({ createdAt: -1 })
    .limit(Math.max(0, historyLimit))
    .select("senderType body createdAt")
    .lean();
  history.reverse();

  let knowledge;
  try {
    knowledge = await retrieveKnowledge({
      companyId,
      knowledgeBaseIds: agent.knowledgeBaseIds || [],
      query: payload.body,
      limit: options.contextLimit || config.AI_CONTEXT_DOCUMENT_LIMIT,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "Knowledge retrieval failed.");
  }
  const userMessage = await createMessage(companyId, conversationId, {
    body: payload.body,
    senderType: payload.senderType || "user",
  }, actor);
  const context = buildContext({
    agent,
    history,
    retrievedKnowledge: knowledge,
    currentUserContent: payload.body,
    options,
  });

  let generated;
  const generationStartedAt = Date.now();
  try {
    const aiService = options.aiService || defaultAIService;
    generated = await aiService.generateResponse({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      context: context.context,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
    });
  } catch (error) {
    if (error instanceof AIProviderError) {
      throw new AppError(error.statusCode || 502, error.message);
    }
    throw new AppError(502, "AI provider request failed.");
  }

  const assistantMessage = await Message.create({
    companyId,
    conversationId: conversation._id,
    senderType: "agent",
    senderId: agent._id,
    body: generated.text || generated.content,
    metadata: {
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage || generated.tokenMetadata || {},
      tokenMetadata: generated.tokenMetadata || generated.usage || {},
      latencyMs: Date.now() - generationStartedAt,
      finishReason: generated.finishReason,
      providerRequestId: generated.providerRequestId || null,
    },
    isDeleted: false,
    deletedAt: null,
  });
  conversation.lastMessageAt = assistantMessage.createdAt || new Date();
  await conversation.save();
  await logAudit({
    user: actor,
    companyId,
    action: "conversation.message.generated",
    entityType: "Conversation",
    entityId: String(conversation._id),
    metadata: {
      agentId: String(agent._id),
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage || generated.tokenMetadata || {},
      latencyMs: assistantMessage.metadata.latencyMs,
    },
  });

  return {
    response: {
      text: generated.text || generated.content,
      content: generated.content || generated.text,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage || generated.tokenMetadata || {},
      tokenMetadata: generated.tokenMetadata || generated.usage || {},
      latencyMs: assistantMessage.metadata.latencyMs,
      finishReason: generated.finishReason,
      providerRequestId: generated.providerRequestId || null,
    },
    userMessage: publicMessage(userMessage),
    assistantMessage: publicMessage(assistantMessage),
  };
}

module.exports = {
  sendConversationMessage,
  sendMessage: sendConversationMessage,
  processMessage: sendConversationMessage,
};
