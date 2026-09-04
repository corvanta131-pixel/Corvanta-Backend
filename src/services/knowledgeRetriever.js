const KnowledgeBase = require("../models/KnowledgeBase");
const KnowledgeDocument = require("../models/KnowledgeDocument");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const config = require("../config/config");

function tokens(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

async function validateKnowledgeBases(companyId, knowledgeBaseIds) {
  if (knowledgeBaseIds !== undefined && !Array.isArray(knowledgeBaseIds)) {
    throw new AppError(400, "knowledgeBaseIds must be an array.");
  }
  const ids = Array.isArray(knowledgeBaseIds) ? [...new Set(knowledgeBaseIds.map(String))] : [];
  ids.forEach((id) => validateObjectId(id, "knowledgeBaseId"));
  if (!ids.length) return [];
  const bases = await KnowledgeBase.find({
    _id: { $in: ids },
    companyId,
    isDeleted: false,
    status: "active",
  }).select("_id").lean();
  if (bases.length !== ids.length) {
    throw new AppError(403, "One or more agent knowledge bases are invalid or unavailable.");
  }
  return ids;
}

async function retrieveKnowledge({ companyId, knowledgeBaseIds = [], query = "", limit = config.AI_CONTEXT_DOCUMENT_LIMIT } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  const ids = await validateKnowledgeBases(companyId, knowledgeBaseIds);
  if (!ids.length) return [];

  const documents = await KnowledgeDocument.find({
    companyId,
    knowledgeBaseId: { $in: ids },
    status: "published",
    isDeleted: false,
  }).select("_id knowledgeBaseId title content summary tags").lean();

  const queryTokens = tokens(query);
  const ranked = documents.map((document) => {
    const haystack = tokens([document.title, document.summary, document.content, ...(document.tags || [])].join(" "));
    const score = queryTokens.reduce((total, token) => total + haystack.filter((item) => item === token).length, 0);
    return { ...document, score };
  }).sort((a, b) => b.score - a.score || String(a._id).localeCompare(String(b._id)));

  return ranked.slice(0, Math.max(0, Math.min(Number(limit) || 0, 50))).map((document) => ({
    id: document._id,
    knowledgeBaseId: document.knowledgeBaseId,
    title: document.title,
    content: document.content || document.summary || "",
    score: document.score,
  }));
}

class KnowledgeRetriever {
  constructor(options = {}) {
    this.limit = options.limit || config.AI_CONTEXT_DOCUMENT_LIMIT;
  }

  retrieve(params) {
    return retrieveKnowledge({ ...params, limit: params?.limit || this.limit });
  }
}

module.exports = { KnowledgeRetriever, retrieveKnowledge, validateKnowledgeBases };
