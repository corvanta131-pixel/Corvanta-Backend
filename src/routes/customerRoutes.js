const express = require("express");
const {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} = require("../controllers/customerController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("customers:read"), listCustomers);
router.post("/", requiresPermission("customers:create"), createCustomer);
router.get("/:id", requiresPermission("customers:read"), getCustomer);
router.patch("/:id", requiresPermission("customers:update"), updateCustomer);
router.delete("/:id", requiresPermission("customers:delete"), deleteCustomer);

module.exports = router;
