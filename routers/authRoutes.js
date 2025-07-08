const express = require("express");
const router = express.Router();
const {
  register,
  login,
  regeneratePseudo,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  getUserDataFromToken,
} = require("../controllers/authController");
const auth = require("../utils/middelware");

router.post("/register", register);
router.post("/login", login);
router.post("/generatePseudo", regeneratePseudo);
router.post("/forgot-password", forgotPassword);
router.post("/verify-code", verifyResetCode);
router.post("/reset-password", resetPassword);
router.get("/user-data", auth, getUserDataFromToken);

module.exports = router;
