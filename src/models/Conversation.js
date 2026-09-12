const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AIAgent",
      default: null,
      index: true,
    },
    participantIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: [],
    }],
    channelType: {
      type: String,
      enum: ["email", "whatsapp", "instagram", "messenger", "webchat", "sms", "api"],
      default: "api",
      index: true,
    },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Channel",
      default: null,
      index: true,
    },
    externalConversationId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    handlingMode: {
      type: String,
      enum: ["AI", "HUMAN", "HYBRID"],
      default: "AI",
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["open", "waiting", "resolved", "archived"],
      default: "open",
      index: true,
    },
    lastMessageAt: {
      type: Date,
      default: null,
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

conversationSchema.index({ companyId: 1, customerId: 1, createdAt: -1 });
conversationSchema.index({ companyId: 1, status: 1, updatedAt: -1 });
conversationSchema.index({ companyId: 1, channelType: 1, externalConversationId: 1 }, { unique: true, partialFilterExpression: { isDeleted: false, externalConversationId: { $type: "string" } } });

module.exports = mongoose.model("Conversation", conversationSchema);
