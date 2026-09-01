const express = require("express");
const { listCompanies, createCompany } = require("../controllers/companyController");
const { protect, authorize, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.get("/", protect, requiresPermission("companies:read"), listCompanies);
router.post("/", protect, authorize("super-admin"), createCompany);

module.exports = router;
