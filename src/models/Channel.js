const mongoose = require("mongoose");

const channelSchema = new mongoose.Schema(
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
    type: {
      type: String,
      enum: ["email", "whatsapp", "instagram", "messenger", "webchat", "sms"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "connecting", "error"],
      default: "inactive",
      index: true,
    },
    externalConfig: {
      type: Object,
      default: {},
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

channelSchema.index({ companyId: 1, type: 1, isDeleted: false }, { unique: true, partialFilterExpression: { isDeleted: false } });

module.exports = mongoose.model("Channel", channelSchema);
