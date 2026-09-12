const mongoose = require("mongoose");

const customerIdentitySchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },
    channelType: {
      type: String,
      enum: ["email", "whatsapp", "instagram", "messenger", "webchat", "sms"],
      required: true,
      index: true,
    },
    externalId: {
      type: String,
      required: true,
      trim: true,
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

customerIdentitySchema.index({ companyId: 1, channelType: 1, externalId: 1 }, { unique: true, sparse: true });
customerIdentitySchema.index({ companyId: 1, customerId: 1, channelType: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("CustomerIdentity", customerIdentitySchema);
