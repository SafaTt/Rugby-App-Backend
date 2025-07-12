// match.helpers.js (ou .ts si TypeScript)
const Match = require("../models/Match");
const Quizz = require("../data/quizz"); // Assure-toi que ce tableau est bien importé

const formatOptions = (choices) => {
  const letters = ["A", "B", "C", "D"];
  return choices.reduce((acc, choice, idx) => {
    acc[letters[idx]] = choice;
    return acc;
  }, {});
};

module.exports.processAnswer = async ({
  matchId,
  userId,
  question,
  selectedOption,
  io,
}) => {
  try {
    const match = await Match.findById(matchId)
      .populate("creatorId")
      .populate("joinerId");

    if (!match || match.isFinished) return;

    const lastQuestion = match.questionsAsked.at(-1);
    if (!lastQuestion) return;

    const alreadyAnswered = lastQuestion.answers.some(
      (a) => a.playerId.toString() === userId.toString()
    );
    if (alreadyAnswered) return;

    const isCorrect = selectedOption === lastQuestion.question.correctOption;
    const isConversion = lastQuestion.question.isConversion === true;
    const conversionPlayerId = lastQuestion.question.conversionPlayerId;
    const isConversionPlayer =
      isConversion && conversionPlayerId?.toString() === userId.toString();

    // Protection: seul le joueur de conversion peut répondre
    if (isConversion && !isConversionPlayer) return;

    const scoreToAdd = isCorrect ? (isConversionPlayer ? 2 : 4) : 0;

    lastQuestion.answers.push({
      playerId: userId,
      selectedOption,
      isCorrect,
      score: scoreToAdd,
      answeredAt: new Date(),
    });

    await match.save();

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: userId,
      questionText: lastQuestion.question.text,
      selectedOption,
      isCorrect,
      answeredAt: new Date(),
    });

    if (isConversion && isConversionPlayer) {
      io.to(matchId).emit("conversion_result", {
        playerId: userId,
        success: isCorrect,
        message: isCorrect
          ? "CONVERSION SUCCESSFUL"
          : "CONVERSION UNSUCCESSFUL",
      });
    }

    // Scores
    let scoreUserOne = 0;
    let scoreUserTwo = 0;

    match.questionsAsked.forEach((q) => {
      q.answers.forEach((a) => {
        if (a.playerId.toString() === match.creatorId._id.toString()) {
          scoreUserOne += a.score || 0;
        } else if (
          match.joinerId &&
          a.playerId.toString() === match.joinerId._id.toString()
        ) {
          scoreUserTwo += a.score || 0;
        }
      });
    });

    io.to(matchId).emit("score_updated", {
      matchId,
      scoreUserOne,
      scoreUserTwo,
    });

    // Conversion logic
    if (!match.hasConversionStarted && !match.conversionBy) {
      let teamToConvert = null;

      if (scoreUserOne === 4) teamToConvert = "playerOne";
      else if (scoreUserTwo === 4) teamToConvert = "playerTwo";

      if (teamToConvert) {
        const convQ =
          Quizz.find((q) => q.isConversion) ||
          Quizz[Math.floor(Math.random() * Quizz.length)];

        const formattedConvOptions = formatOptions(convQ.choices);

        match.hasConversionStarted = true;
        match.conversionBy = teamToConvert;

        const conversionPlayerId =
          teamToConvert === "playerOne"
            ? match.creatorId._id
            : match.joinerId._id;

        match.questionsAsked.push({
          question: {
            text: convQ.question,
            options: formattedConvOptions,
            correctOption: convQ.correctAnswer,
            isConversion: true,
            conversionPlayerId,
          },
          answers: [],
        });

        await match.save();

        io.to(matchId).emit("conversion_question", {
          playerId: conversionPlayerId,
          matchId,
          question: {
            text: convQ.question,
            choices: formattedConvOptions,
            correctAnswer: convQ.correctAnswer,
          },
        });

        return;
      }
    }

    // Si 2 réponses => prochaine question
    if (lastQuestion.answers.length >= 2) {
      const nextIndex = match.questionsAsked.length;
      if (nextIndex < Quizz.length) {
        const nextQ = Quizz[nextIndex];
        const formattedOptions = formatOptions(nextQ.choices);

        match.questionsAsked.push({
          question: {
            text: nextQ.question,
            options: formattedOptions,
            correctOption: nextQ.correctAnswer,
            isConversion: nextQ.isConversion || false,
          },
          answers: [],
        });

        await match.save();

        io.to(matchId).emit("next_question", {
          question: {
            text: nextQ.question,
            choices: formattedOptions,
            correctAnswer: nextQ.correctAnswer,
          },
        });
      } else {
        match.isFinished = true;
        await match.save();
        io.to(matchId).emit("match_finished", {
          message: "Le quiz est terminé ! Merci d'avoir joué.",
        });
      }
    }
  } catch (err) {
    console.error("❌ Erreur dans processAnswer:", err);
  }
};
