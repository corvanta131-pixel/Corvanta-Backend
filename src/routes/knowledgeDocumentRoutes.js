const express = require("express");
const { listKnowledgeDocuments, getKnowledgeDocument, createKnowledgeDocument, updateKnowledgeDocument, deleteKnowledgeDocument } = require("../controllers/knowledgeDocumentController");
const { indexKnowledgeDocument, getKnowledgeDocumentIndexStatus, removeKnowledgeDocumentIndex } = require("../controllers/knowledgeIngestionController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("knowledge:read"), listKnowledgeDocuments);
router.post("/", requiresPermission("knowledge:create"), createKnowledgeDocument);
router.get("/:id", requiresPermission("knowledge:read"), getKnowledgeDocument);
router.patch("/:id", requiresPermission("knowledge:update"), updateKnowledgeDocument);
router.delete("/:id", requiresPermission("knowledge:delete"), deleteKnowledgeDocument);
router.post("/:id/index", requiresPermission("knowledge:update"), indexKnowledgeDocument);
router.get("/:id/index-status", requiresPermission("knowledge:read"), getKnowledgeDocumentIndexStatus);
router.delete("/:id/index", requiresPermission("knowledge:update"), removeKnowledgeDocumentIndex);

module.exports = router;
