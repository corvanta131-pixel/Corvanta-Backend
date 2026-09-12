const Conversation = require("../models/Conversation");
const AIAgent = require("../models/AIAgent");
const Customer = require("../models/Customer");
const Message = require("../models/Message");
const AppError = require("../utils/AppError");
const config = require("../config/config");
const { validateObjectId } = require("../validators/commonValidator");
const { defaultAIService, AIProviderError } = require("./ai/aiService");
const { retrieveKnowledge, retrieveKnowledgeSemantic } = require("./knowledgeRetriever");
const { buildContext, buildPromptWithUntrustedKnowledge, buildSources } = require("./contextBuilder");
const { createMessage, publicMessage } = require("./messageService");
const { logAudit } = require("./auditService");
const { getEmbeddingProvider, getVectorStore } = require("./ragRuntime");
const { createProvider, createAIService } = require("./ai/providerRegistry");

function resolveAIService(agent, options) {
  if (options.aiService) return options.aiService;
  const provider = options.provider || createProvider(agent.provider, {
    apiKey: config.OPENAI_API_KEY,
    organization: config.OPENAI_ORGANIZATION,
    model: agent.model,
    timeoutMs: config.AI_PROVIDER_TIMEOUT_MS,
  });
  return createAIService(agent.provider, {
    provider,
    timeoutMs: config.AI_PROVIDER_TIMEOUT_MS,
    maxRetries: config.AI_MAX_RETRIES,
    retryBaseDelayMs: config.AI_RETRY_BASE_DELAY_MS,
  });
}

function enforcePromptLimits({ composed, agent, options }) {
  const userMessageChars = String(composed.userPrompt || "").length;
  const userMax = config.AI_USER_MESSAGE_MAX_CHARS || 20000;
  if (userMessageChars > userMax) {
    throw new AppError(400, `User message exceeds maximum length of ${userMax} characters.`);
  }
  const totalSystemChars = String(composed.systemPrompt || "").length;
  const systemMax = config.AI_MAX_PROMPT_CHARS || 60000;
  if (totalSystemChars > systemMax) {
    throw new AppError(400, `System prompt plus context exceeds maximum length of ${systemMax} characters.`);
  }
}

async function performKnowledgeRetrieval({ companyId, agent, payload, options }) {
  const retrievalLimit = options.contextLimit || config.AI_CONTEXT_DOCUMENT_LIMIT;
  const retrievalOptions = {
    limit: retrievalLimit,
    embeddingProvider: options.embeddingProvider || (options.useSemantic ? getEmbeddingProvider() : null),
    embeddingProviderName: options.embeddingProviderName,
    embeddingApiKey: options.embeddingApiKey,
    embeddingModel: options.embeddingModel,
    embeddingDimensions: options.embeddingDimensions,
    embeddingTimeoutMs: options.embeddingTimeoutMs,
    vectorStore: options.vectorStore || (options.useSemantic ? getVectorStore() : null),
  };
  if (options.useSemantic || options.embeddingProvider || options.vectorStore) {
    return retrieveKnowledgeSemantic({
      companyId,
      knowledgeBaseIds: agent.knowledgeBaseIds || [],
      query: payload.body,
      limit: retrievalLimit,
      options: retrievalOptions,
    });
  }
  return retrieveKnowledge({
    companyId,
    knowledgeBaseIds: agent.knowledgeBaseIds || [],
    query: payload.body,
    limit: retrievalLimit,
  });
}

function resolveSystemPromptAndMessages({ agent, history, retrievedKnowledge, currentUserContent, options }) {
  const composed = buildPromptWithUntrustedKnowledge({
    systemPrompt: agent.promptTemplate,
    userContent: currentUserContent,
    retrievedKnowledge,
  });
  const systemPrompt = composed.systemPrompt + (composed.knowledgeBlock ? `\n\n${composed.knowledgeBlock}` : "");
  const messages = history.map((message) => ({
    role: message.senderType === "system" ? "system" : (message.senderType === "agent" || message.senderType === "assistant" ? "assistant" : "user"),
    content: message.body,
  }));
  if (currentUserContent) messages.push({ role: "user", content: currentUserContent });
  return { systemPrompt, messages, knowledgeBlock: composed.knowledgeBlock, userPrompt: composed.userPrompt };
}

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

  const historyLimit = Number(options.historyLimit || config.AI_HISTORY_MESSAGE_LIMIT);
  const history = await Message.find({ companyId, conversationId: conversation._id, isDeleted: false })
    .sort({ createdAt: -1 })
    .limit(Math.max(0, historyLimit))
    .select("senderType body createdAt")
    .lean();
  history.reverse();

  let knowledge;
  try {
    knowledge = await performKnowledgeRetrieval({ companyId, agent, payload, options });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "Knowledge retrieval failed.");
  }

  const userMessage = await createMessage(companyId, conversationId, {
    body: payload.body,
    senderType: payload.senderType || "user",
  }, actor);
  const composed = resolveSystemPromptAndMessages({
    agent,
    history,
    retrievedKnowledge: knowledge,
    currentUserContent: payload.body,
    options,
  });
  enforcePromptLimits({ composed, agent, options });

  let generated;
  const generationStartedAt = Date.now();
  try {
    const aiService = resolveAIService(agent, options);
    generated = await aiService.generateResponse({
      systemPrompt: composed.systemPrompt,
      messages: composed.messages,
      context: knowledge,
      temperature: agent.temperature,
      maxTokens: Math.min(agent.maxTokens, config.AI_MAX_OUTPUT_TOKENS),
    });
  } catch (error) {
    if (error instanceof AIProviderError) {
      throw new AppError(error.statusCode || 502, error.message);
    }
    throw new AppError(502, "AI provider request failed.");
  }

  const sources = buildSources(knowledge);
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
      embeddingUsage: options.embeddingUsage || {},
      latencyMs: Date.now() - generationStartedAt,
      finishReason: generated.finishReason,
      providerRequestId: generated.providerRequestId || null,
      retrievalMode: options.useSemantic || options.embeddingProvider || options.vectorStore ? "semantic" : "deterministic",
      sourceCount: sources.length,
      sources,
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
      retrievalMode: assistantMessage.metadata.retrievalMode,
      sourceCount: sources.length,
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
      embeddingUsage: options.embeddingUsage || {},
      latencyMs: assistantMessage.metadata.latencyMs,
      finishReason: generated.finishReason,
      providerRequestId: generated.providerRequestId || null,
      retrievalMode: assistantMessage.metadata.retrievalMode,
    },
    sources,
    userMessage: publicMessage(userMessage),
    assistantMessage: publicMessage(assistantMessage),
  };
}

module.exports = {
  sendConversationMessage,
  sendMessage: sendConversationMessage,
  processMessage: sendConversationMessage,
};
