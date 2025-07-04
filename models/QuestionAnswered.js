const mongoose = require("mongoose");

// ✅ Déclaration du schéma (pas un modèle ici)
const QuestionAnsweredSchema = new mongoose.Schema(
  {
    question: {
      text: { type: String, required: true },
      options: {
        type: Map,
        of: String,
        required: true,
      },
      correctOption: { type: String, required: true },
    },

    answers: [
      {
        playerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        selectedOption: { type: String, required: true },
        isCorrect: { type: Boolean, required: true },
        score: { type: Number, required: true },
        answeredAt: { type: Date, default: Date.now },
      },
    ],
  },
  { _id: false }
);

module.exports = QuestionAnsweredSchema;
