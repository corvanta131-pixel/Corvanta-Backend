const mongoose = require("mongoose");

const ingestionJobSchema = new mongoose.Schema(
  {
    jobId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeDocument",
      required: true,
      index: true,
    },
    knowledgeBaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeBase",
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "indexed", "index_failed"],
      default: "pending",
      index: true,
    },
    attemptCount: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    processingDurationMs: {
      type: Number,
      default: 0,
    },
    chunkCount: {
      type: Number,
      default: 0,
    },
    vectorCount: {
      type: Number,
      default: 0,
    },
    embeddingProvider: {
      type: String,
      default: "",
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
    errorCode: {
      type: String,
      default: "",
    },
    errorMessage: {
      type: String,
      default: "",
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

ingestionJobSchema.index({ companyId: 1, status: 1, createdAt: -1 });
ingestionJobSchema.index({ documentId: 1, status: 1 });
ingestionJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("IngestionJob", ingestionJobSchema);