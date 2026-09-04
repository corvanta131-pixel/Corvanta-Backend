const express = require("express");
const healthRoutes = require("./healthRoutes");
const authRoutes = require("./authRoutes");
const companyRoutes = require("./companyRoutes");
const userRoutes = require("./userRoutes");
const customerRoutes = require("./customerRoutes");
const agentRoutes = require("./agentRoutes");
const knowledgeBaseRoutes = require("./knowledgeBaseRoutes");
const knowledgeDocumentRoutes = require("./knowledgeDocumentRoutes");
const conversationRoutes = require("./conversationRoutes");

const router = express.Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/companies", companyRoutes);
router.use("/users", userRoutes);
router.use("/customers", customerRoutes);
router.use("/agents", agentRoutes);
router.use("/knowledge-bases", knowledgeBaseRoutes);
router.use("/knowledge-documents", knowledgeDocumentRoutes);
router.use("/conversations", conversationRoutes);

module.exports = router;
