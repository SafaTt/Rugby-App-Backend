const mongoose = require("mongoose");

const resetCodeSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // expire après 10 minutes
});

module.exports = mongoose.model("ResetCode", resetCodeSchema);
