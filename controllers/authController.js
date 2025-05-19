// controllers/authController.js
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const ResetCode = require("../models/ResetCode");
require("dotenv").config();

// Config mail
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const register = async (req, res) => {
  try {
    const { email, password, pseudo } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      email,
      password: hashedPassword,
      pseudo: pseudo?.trim() || generatePseudo(),
    });

    await user.save();

    res
      .status(201)
      .json({ message: "User created successfully", pseudo: user.pseudo });
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email });
    if (!user) {
      return res.status(400).json({ message: "Email or Password incorrect." });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Email or Password incorrect." });
    }

    const token = jwt.sign(
      { userId: user._id, pseudo: user.pseudo },
      "RUGBY_APP_SECRET_KEY"
      // { expiresIn: "7d" }
    );

    res.status(200).json({
      token,
      user: { id: user._id, pseudo: user.pseudo, email: user.email },
    });
  } catch (error) {
    console.error("Erreur lors de la connexion :", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
};

const generatePseudo = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `Rugby${suffix}`;
};

const regeneratePseudo = (req, res) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res.status(200).json({ pseudo: `Rugby${suffix}` });
};

// 1. Send a verification code to the email
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "Email not found." });
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    await ResetCode.deleteMany({ email });

    const reset = new ResetCode({ email, code });
    await reset.save();

    // Send mail
    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: email,
      subject: "Reset code",
      text: `Your reset code is: ${code}`,
    });

    res.status(200).json({ message: "Code sent to your email address." });
  } catch (error) {
    console.error("Erreur envoi mail :", error);
    res.status(500).json({ message: "Server error." });
  }
};

// 2. verif code
const verifyResetCode = async (req, res) => {
  const { email, code } = req.body;

  try {
    const found = await ResetCode.findOne({ email, code });
    if (!found) return res.status(400).json({ message: "Invalid code." });

    res.status(200).json({ message: "Code verified successfully." });
  } catch (error) {
    res.status(500).json({ message: "Server error." });
  }
};

// 3. reset password
const resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    const found = await ResetCode.findOne({ email, code });
    if (!found)
      return res.status(400).json({ message: "Invalid or expired code." });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email }, { password: hashedPassword });

    await ResetCode.deleteMany({ email });

    res.status(200).json({ message: "Password updated successfully." });
  } catch (error) {
    res.status(500).json({ message: "Erreur serveur." });
  }
};

module.exports = {
  register,
  login,
  generatePseudo,
  regeneratePseudo,
  forgotPassword,
  verifyResetCode,
  resetPassword,
};
