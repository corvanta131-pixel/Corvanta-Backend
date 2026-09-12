const mongoose = require("mongoose");

const TRIGGER_TYPES = Object.freeze([
  "message.received",
  "conversation.created",
  "conversation.updated",
  "customer.created",
]);

const ACTION_TYPES = Object.freeze([
  "assign.conversation.employee",
  "assign.conversation.agent",
  "update.conversation.status",
  "update.conversation.metadata",
  "update.customer.info",
  "create.audit.event",
  "send.message",
]);

const CONDITION_OPERATORS = Object.freeze([
  "eq",
  "ne",
  "in",
  "nin",
  "contains",
  "startsWith",
  "endsWith",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
]);

const PROTECTED_WORKFLOW_FIELDS = Object.freeze([
  "companyId",
  "createdBy",
  "updatedBy",
  "isDeleted",
  "deletedAt",
  "createdAt",
  "updatedAt",
  "id",
  "_id",
]);

const ALLOWED_CUSTOMER_UPDATE_FIELDS = Object.freeze([
  "name",
  "email",
  "phone",
  "notes",
  "status",
  "metadata",
]);

const workflowSchema = new mongoose.Schema(
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
      maxlength: 200,
    },
    description: {
      type: String,
      default: "",
      maxlength: 2000,
    },
    status: {
      type: String,
      enum: ["draft", "active", "inactive"],
      default: "draft",
      index: true,
    },
    trigger: {
      type: {
        type: String,
        enum: TRIGGER_TYPES,
        required: true,
      },
      config: {
        type: Object,
        default: {},
      },
    },
    priority: {
      type: Number,
      default: 100,
      min: 0,
      max: 10000,
      index: true,
    },
    conditions: [
      {
        field: { type: String, required: true },
        operator: { type: String, enum: CONDITION_OPERATORS, required: true },
        value: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    actions: [
      {
        type: { type: String, enum: ACTION_TYPES, required: true },
        params: { type: Object, default: {} },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

workflowSchema.index({ companyId: 1, status: 1, isDeleted: 1, priority: -1, createdAt: 1 });
workflowSchema.index({ companyId: 1, "trigger.type": 1, isDeleted: 1, status: 1 });

module.exports = mongoose.model("Workflow", workflowSchema);
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
module.exports.ACTION_TYPES = ACTION_TYPES;
module.exports.CONDITION_OPERATORS = CONDITION_OPERATORS;
module.exports.PROTECTED_WORKFLOW_FIELDS = PROTECTED_WORKFLOW_FIELDS;
module.exports.ALLOWED_CUSTOMER_UPDATE_FIELDS = ALLOWED_CUSTOMER_UPDATE_FIELDS;
