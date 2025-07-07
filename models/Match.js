const mongoose = require("mongoose");
const QuestionAnsweredSchema = require("./QuestionAnswered");

const teamSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    color: { type: String, required: true, trim: true },
    textColor: { type: String, required: true, trim: true },
  },
  { _id: false }
); // _id: false pour ne pas créer d'ID supplémentaire pour cet objet

const matchSchema = new mongoose.Schema(
  {
    competition: {
      type: String,
      required: true,
      trim: true,
    },
    duration: {
      type: String,
      required: true,
      trim: true,
    },
    playerOneTeam: {
      type: teamSchema,
      required: true,
    },
    playerTwoTeam: {
      type: teamSchema,
      required: false,
    },
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    joinerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    status: {
      type: String,
      enum: ["waiting", "in-progress", "finished"],
      default: "waiting",
    },
    startTime: {
      type: Date,
      default: null,
    },
    questionsAsked: [QuestionAnsweredSchema],
    quizStarted: {
      type: Boolean,
      default: false,
    },
    isFinished: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Match", matchSchema);
