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
    body: {
      type: String,
      required: true,
      trim: true,
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

module.exports = mongoose.model("Message", messageSchema);
