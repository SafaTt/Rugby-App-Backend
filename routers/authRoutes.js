const express = require("express");
const router = express.Router();
const {
  register,
  login,
  regeneratePseudo,
  forgotPassword,
  verifyResetCode,
  resetPassword,
} = require("../controllers/authController");

router.post("/register", register);
router.post("/login", login);
router.post("/generatePseudo", regeneratePseudo);
router.post("/forgot-password", forgotPassword);
router.post("/verify-code", verifyResetCode);
router.post("/reset-password", resetPassword);

module.exports = router;
