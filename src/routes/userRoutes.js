const express = require("express");
const {
  getCurrentUser,
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} = require("../controllers/userController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.get("/me", protect, getCurrentUser);
router.get("/", protect, requiresPermission("employees:read"), listEmployees);
router.post("/", protect, requiresPermission("employees:create"), createEmployee);
router.get("/:id", protect, requiresPermission("employees:read"), getEmployee);
router.patch("/:id", protect, requiresPermission("employees:update"), updateEmployee);
router.delete("/:id", protect, requiresPermission("employees:delete"), deleteEmployee);

module.exports = router;
