const express = require("express");
const { listKnowledgeDocuments, getKnowledgeDocument, createKnowledgeDocument, updateKnowledgeDocument, deleteKnowledgeDocument } = require("../controllers/knowledgeDocumentController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("knowledge:read"), listKnowledgeDocuments);
router.post("/", requiresPermission("knowledge:create"), createKnowledgeDocument);
router.get("/:id", requiresPermission("knowledge:read"), getKnowledgeDocument);
router.patch("/:id", requiresPermission("knowledge:update"), updateKnowledgeDocument);
router.delete("/:id", requiresPermission("knowledge:delete"), deleteKnowledgeDocument);

module.exports = router;
