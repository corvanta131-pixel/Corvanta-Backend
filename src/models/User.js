const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
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
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      default: null,
      index: true,
    },
    employeeCode: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    department: {
      type: String,
      trim: true,
      default: "",
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "invited", "disabled"],
      default: "active",
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

userSchema.index({ companyId: 1, email: 1 }, { unique: true, sparse: true });
userSchema.index({ companyId: 1, status: 1 });
userSchema.index({ companyId: 1, department: 1, createdAt: -1 });

userSchema.methods.toPublicJSON = function toPublicJSON() {
  const userObject = this.toObject();
  delete userObject.passwordHash;
  return userObject;
};

module.exports = mongoose.model("User", userSchema);
