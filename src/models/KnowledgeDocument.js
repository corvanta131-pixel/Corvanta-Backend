const mongoose = require("mongoose");

const knowledgeDocumentSchema = new mongoose.Schema(
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
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      default: "",
    },
    summary: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
      index: true,
    },
    tags: [{
      type: String,
      trim: true,
    }],
    source: {
      type: String,
      default: "manual",
    },
    fileName: {
      type: String,
      default: "",
    },
    mimeType: {
      type: String,
      default: "text/plain",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    metadata: {
      type: Object,
      default: {},
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

knowledgeDocumentSchema.index({ companyId: 1, knowledgeBaseId: 1, status: 1, createdAt: -1 });
knowledgeDocumentSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("KnowledgeDocument", knowledgeDocumentSchema);
