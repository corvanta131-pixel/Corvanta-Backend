const mongoose = require("mongoose");

const knowledgeChunkSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    knowledgeBaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeBase",
      required: true,
      index: true,
    },
    knowledgeDocumentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeDocument",
      required: true,
      index: true,
    },
    chunkIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    content: {
      type: String,
      required: true,
    },
    contentHash: {
      type: String,
      required: true,
      index: true,
    },
    metadata: {
      type: Object,
      default: {},
    },
    embeddingProvider: {
      type: String,
      default: "mock",
    },
    embeddingModel: {
      type: String,
      default: "",
    },
    embeddingDimensions: {
      type: Number,
      default: 0,
    },
    embeddingUsage: {
      type: Object,
      default: {},
    },
    vectorStoreId: {
      type: String,
      default: "",
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

knowledgeChunkSchema.index({ companyId: 1, knowledgeDocumentId: 1, chunkIndex: 1 }, { unique: true });
knowledgeChunkSchema.index({ companyId: 1, knowledgeBaseId: 1, isDeleted: 1 });
knowledgeChunkSchema.index({ companyId: 1, isDeleted: 1, createdAt: -1 });

module.exports = mongoose.model("KnowledgeChunk", knowledgeChunkSchema);
