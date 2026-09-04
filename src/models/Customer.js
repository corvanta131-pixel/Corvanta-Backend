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

customerSchema.index({ companyId: 1, email: 1 }, { unique: true, sparse: true });
customerSchema.index({ companyId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Customer", customerSchema);
