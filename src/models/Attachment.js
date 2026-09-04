const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
      index: true,
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
      index: true,
    },
    entityType: {
      type: String,
      enum: ["message", "knowledge_document", "customer", "conversation"],
      default: "message",
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      default: "application/octet-stream",
    },
    sizeBytes: {
      type: Number,
      default: 0,
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      default: "",
    },
    provider: {
      type: String,
      default: "local",
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

attachmentSchema.index({ companyId: 1, createdAt: -1 });
attachmentSchema.index({ companyId: 1, conversationId: 1, messageId: 1 });

module.exports = mongoose.model("Attachment", attachmentSchema);
