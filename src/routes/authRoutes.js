const express = require("express");
const { register, login, refresh, logout, getMe } = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { createAuthLimiter } = require("../config/rateLimits");

const router = express.Router();

router.post("/register", createAuthLimiter(), register);
router.post("/login", createAuthLimiter(), login);
router.post("/refresh", createAuthLimiter(), refresh);
router.post("/logout", protect, logout);
router.get("/me", protect, getMe);

module.exports = router;
