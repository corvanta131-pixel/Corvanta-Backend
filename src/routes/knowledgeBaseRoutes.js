const express = require("express");
const { listKnowledgeBases, getKnowledgeBase, createKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase } = require("../controllers/knowledgeBaseController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("knowledge:read"), listKnowledgeBases);
router.post("/", requiresPermission("knowledge:create"), createKnowledgeBase);
router.get("/:id", requiresPermission("knowledge:read"), getKnowledgeBase);
router.patch("/:id", requiresPermission("knowledge:update"), updateKnowledgeBase);
router.delete("/:id", requiresPermission("knowledge:delete"), deleteKnowledgeBase);

module.exports = router;
