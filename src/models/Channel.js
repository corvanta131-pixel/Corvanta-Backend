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
    // Messaging-provider connection (WhatsApp, Messenger, Instagram, SMS, email). Written ONLY by
    // connectorService; the generic channel endpoints whitelist their own fields. `credentials` is
    // AES-256-GCM encrypted and never selected by default or returned by any API.
    connector: {
      webhookKey: { type: String },
      verifyToken: { type: String },
      credentials: { type: String, select: false },
      display: { type: Object, default: undefined },
      agentId: { type: mongoose.Schema.Types.ObjectId, ref: "AIAgent", default: undefined },
      aiReplies: { type: Boolean, default: undefined },
      lastTest: { type: Object, default: undefined },
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

channelSchema.index({ "connector.webhookKey": 1 }, { unique: true, sparse: true, name: "connector_webhook_key_unique" });
channelSchema.index({ "widget.key": 1 }, { unique: true, sparse: true, name: "widget_key_unique" });

module.exports = mongoose.model("Channel", channelSchema);
