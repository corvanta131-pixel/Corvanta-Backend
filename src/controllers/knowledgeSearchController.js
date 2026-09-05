const asyncHandler = require("../utils/asyncHandler");
const { validateObjectId } = require("../validators/commonValidator");
const { validateKnowledgeSearchInput } = require("../validators/domainValidator");
const { searchKnowledge } = require("../services/knowledgeSearchService");
const KnowledgeBase = require("../models/KnowledgeBase");
const AppError = require("../utils/AppError");

exports.searchKnowledgeBases = asyncHandler(async (req, res) => {
  validateKnowledgeSearchInput(req.body);
  const knowledgeBaseIds = Array.isArray(req.body.knowledgeBaseIds) ? req.body.knowledgeBaseIds : [];
  for (const id of knowledgeBaseIds) validateObjectId(id, "knowledgeBaseId");
  if (knowledgeBaseIds.length) {
    const count = await KnowledgeBase.countDocuments({
      _id: { $in: knowledgeBaseIds },
      companyId: req.user.companyId,
      isDeleted: false,
      status: "active",
    });
    if (count !== knowledgeBaseIds.length) throw new AppError(403, "One or more knowledge bases are not accessible.");
  }
  const results = await searchKnowledge({
    companyId: req.user.companyId,
    query: req.body.query,
    knowledgeBaseIds,
    limit: req.body.limit,
    options: { useSemantic: true },
  });
  res.status(200).json({ success: true, data: results });
});
