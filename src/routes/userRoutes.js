const express = require("express");
const { getCurrentUser } = require("../controllers/userController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.get("/me", protect, getCurrentUser);

module.exports = router;
