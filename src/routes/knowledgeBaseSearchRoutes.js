const express = require("express");
const { searchKnowledgeBases } = require("../controllers/knowledgeSearchController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.post("/search", requiresPermission("knowledge:read"), searchKnowledgeBases);

module.exports = router;
