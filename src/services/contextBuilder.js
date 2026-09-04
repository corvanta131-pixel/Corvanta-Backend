const config = require("../config/config");

function trimText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function buildContext({ agent = {}, history = [], retrievedKnowledge = [], currentUserContent = "", options = {} } = {}) {
  const historyLimit = Number(options.historyLimit || config.AI_HISTORY_MESSAGE_LIMIT);
  const contextLimit = Number(options.contextLimit || config.AI_CONTEXT_DOCUMENT_LIMIT);
  const maxChars = Number(options.maxChars || config.AI_CONTEXT_MAX_CHARS);
  const boundedHistory = history.slice(-Math.max(0, historyLimit)).map((message) => ({
    role: message.senderType === "system"
      ? "system"
      : (message.senderType === "assistant" || message.senderType === "agent" ? "assistant" : "user"),
    content: trimText(message.body, maxChars),
  }));
  const context = [];
  let contextChars = 0;
  for (const document of retrievedKnowledge.slice(0, Math.max(0, contextLimit))) {
    const remaining = Math.max(0, maxChars - contextChars);
    if (!remaining) break;
    const content = trimText(document.content || document.summary, remaining);
    context.push({
      id: document.id || document._id,
      title: trimText(document.title, Math.min(300, remaining)),
      content,
    });
    contextChars += content.length;
  }
  const systemPrompt = trimText(agent.promptTemplate, maxChars);
  const current = trimText(currentUserContent, maxChars);

  return {
    systemPrompt,
    conversationHistory: boundedHistory,
    retrievedKnowledge: context,
    currentUserContent: current,
    messages: current ? [...boundedHistory, { role: "user", content: current }] : boundedHistory,
    context,
  };
}

module.exports = { buildContext };
