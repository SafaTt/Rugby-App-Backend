const jwt = require("jsonwebtoken");
const User = require("../models/User");

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Accès non autorisé (token manquant)" });
    }

    const token = authHeader.split(" ")[1];
    const secretKey = process.env.JWT_SECRET || "ma_cle_secrete_test";

    const decoded = jwt.verify(token, secretKey);

    const user = await User.findById(decoded.userId).select("-password");
    if (!user)
      return res.status(404).json({ message: "Utilisateur non trouvé" });

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Token invalide ou expiré", error });
  }
};

module.exports = auth;
