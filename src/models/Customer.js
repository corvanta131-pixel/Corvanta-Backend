const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
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
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "inactive", "prospect", "archived"],
      default: "active",
      index: true,
    },
    notes: {
      type: String,
      default: "",
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

// Unique only for customers that actually have an email ("" is the default and must not collide).
// NOTE: an existing deployment still has the old index; run scripts/migrate-owner-role-and-customer-index.js once.
customerSchema.index(
  { companyId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: "" } }, name: "companyId_1_email_1_partial" }
);
customerSchema.index({ companyId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Customer", customerSchema);
