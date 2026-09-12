const mongoose = require("mongoose");

const EXECUTION_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

const workflowExecutionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workflow",
      required: true,
      index: true,
    },
    eventId: {
      type: String,
      default: null,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: EXECUTION_STATUSES,
      default: "pending",
      index: true,
    },
    triggerMatch: {
      type: Boolean,
      default: false,
    },
    conditionResults: [
      {
        field: String,
        operator: String,
        expected: mongoose.Schema.Types.Mixed,
        actual: mongoose.Schema.Types.Mixed,
        passed: Boolean,
      },
    ],
    actionsExecuted: [
      {
        actionType: String,
        params: Object,
        status: { type: String, enum: ["success", "failed"], default: "success" },
        result: { type: mongoose.Schema.Types.Mixed, default: null },
        error: { type: String, default: null },
        executedAt: { type: Date, default: Date.now },
      },
    ],
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
    executionTimeMs: {
      type: Number,
      default: null,
    },
    metadata: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

workflowExecutionSchema.index({ companyId: 1, createdAt: -1 });
workflowExecutionSchema.index({ workflowId: 1, createdAt: -1 });
workflowExecutionSchema.index({ companyId: 1, eventId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("WorkflowExecution", workflowExecutionSchema);
module.exports.EXECUTION_STATUSES = EXECUTION_STATUSES;
