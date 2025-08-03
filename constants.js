const mongoose = require("mongoose");

// ID fixe réservé à l'IA
const AI_PLAYER_ID = new mongoose.Types.ObjectId("000000000000000000000001");

module.exports = { AI_PLAYER_ID };
