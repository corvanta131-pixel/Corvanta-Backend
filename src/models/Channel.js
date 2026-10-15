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
    // Public web-chat widget settings. Written ONLY by widgetService (never by the generic channel
    // create/update endpoints, which whitelist their own fields), so a tenant cannot choose a key
    // that collides with another tenant's widget.
    widget: {
      key: { type: String },
      allowedOrigins: { type: [String], default: undefined },
      agentId: { type: mongoose.Schema.Types.ObjectId, ref: "AIAgent", default: undefined },
      title: { type: String },
      welcomeMessage: { type: String },
      color: { type: String },
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

channelSchema.index({ "widget.key": 1 }, { unique: true, sparse: true, name: "widget_key_unique" });

module.exports = mongoose.model("Channel", channelSchema);
