const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
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
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      default: "inbound",
      index: true,
    },
    senderType: {
      type: String,
      enum: ["user", "customer", "agent", "system"],
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    senderIdentity: {
      type: String,
      default: "",
      trim: true,
    },
    externalMessageId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    externalConversationId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    attachments: [{
      type: Object,
      default: [],
    }],
    deliveryStatus: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed"],
      default: "pending",
      index: true,
    },
    deliveryError: {
      type: String,
      default: null,
    },
    deliveredAt: {
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

messageSchema.index({ companyId: 1, conversationId: 1, createdAt: -1 });
messageSchema.index({ companyId: 1, channelType: 1, externalMessageId: 1 }, { unique: true, partialFilterExpression: { isDeleted: false, externalMessageId: { $type: "string" } } });

module.exports = mongoose.model("Message", messageSchema);
