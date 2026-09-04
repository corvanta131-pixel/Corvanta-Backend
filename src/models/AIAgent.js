const mongoose = require("mongoose");

const aiAgentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["draft", "active", "disabled", "archived"],
      default: "draft",
      index: true,
    },
    model: {
      type: String,
      default: "gpt-4o-mini",
    },
    provider: {
      type: String,
      default: "mock",
      trim: true,
      lowercase: true,
    },
    temperature: {
      type: Number,
      min: 0,
      max: 2,
      default: 0.2,
    },
    maxTokens: {
      type: Number,
      min: 1,
      max: 32768,
      default: 512,
    },
    promptTemplate: {
      type: String,
      default: "",
    },
    responseConfig: {
      type: Object,
      default: {},
    },
    fallbackConfig: {
      type: Object,
      default: {},
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    knowledgeBaseIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeBase",
      default: [],
    }],
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

aiAgentSchema.index({ companyId: 1, slug: 1 }, { unique: true });
aiAgentSchema.index({ companyId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("AIAgent", aiAgentSchema);
