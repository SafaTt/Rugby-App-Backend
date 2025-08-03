const Match = require("../models/Match");
const Quizz = require("../models/Quizz");
const matchTimers = new Map();

async function makeAIMove(matchId, io) {
  const match = await Match.findById(matchId);
  if (!match || match.isFinished || !match.quizStarted) return;

  if (!match.isAgainstAI) return;

  const lastQuestion = match.questionsAsked.at(-1);
  if (!lastQuestion) return;

  // Vérifier si l'IA a déjà répondu
  if (lastQuestion.answers.find((a) => a.playerId === "AI_BOT")) return;

  const accuracy = match.aiSettings?.accuracyRate ?? 0.7;
  const willAnswerCorrectly = Math.random() < accuracy;

  let selectedOption;
  if (willAnswerCorrectly) {
    selectedOption = lastQuestion.question.correctOption;
  } else {
    const options = Object.keys(lastQuestion.question.options).filter(
      (opt) => opt !== lastQuestion.question.correctOption
    );
    selectedOption = options[Math.floor(Math.random() * options.length)];
  }

  // Simuler un délai d'attente (ex : 2s)
  await new Promise((resolve) =>
    setTimeout(resolve, match.aiSettings?.responseDelayMs ?? 2000)
  );

  // Ajouter la réponse IA
  lastQuestion.answers.push({
    playerId: "AI_BOT",
    selectedOption,
    isCorrect: selectedOption === lastQuestion.question.correctOption,
    score: selectedOption === lastQuestion.question.correctOption ? 4 : 0,
    answeredAt: new Date(),
  });

  await match.save();

  // Émettre l'événement à tous dans la salle
  io.to(matchId).emit("answer_question", {
    matchId,
    playerId: "AI_BOT",
    questionText: lastQuestion.question.text,
    selectedOption,
    isCorrect: selectedOption === lastQuestion.question.correctOption,
    answeredAt: new Date(),
  });
}

async function handleAnswerQuestion({ matchId, userId, selectedOption, io }) {
  try {
    const match = await Match.findById(matchId)
      .populate("creatorId")
      .populate("joinerId");

    if (!match || match.isFinished) return;

    const lastQuestion = match.questionsAsked.at(-1);
    if (!lastQuestion) return;

    const isGoldenPoint = matchTimers.get(matchId)?.isGoldenPoint === true;
    const isHandled = matchTimers.get(matchId)?.handled === true;

    // Gestion GOLDEN POINT
    if (isGoldenPoint && !isHandled) {
      const isCorrect = selectedOption === lastQuestion.question.correctOption;

      if (isCorrect) {
        lastQuestion.answers.push({
          playerId: userId,
          selectedOption,
          isCorrect,
          score: 1, // point unique en Golden Point
          answeredAt: new Date(),
        });

        await match.save();

        // Calcul scores
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

        io.to(matchId).emit("golden_point_winner", {
          winnerId: userId,
          message: "🏆 GOLDEN POINT! The player answered correctly!",
          scoreUserOne,
          scoreUserTwo,
        });

        io.to(matchId).emit("score_updated", {
          matchId,
          scoreUserOne,
          scoreUserTwo,
        });

        clearTimeout(matchTimers.get(matchId)?.timer);
        matchTimers.set(matchId, {
          ...matchTimers.get(matchId),
          handled: true,
        });

        await Match.findByIdAndUpdate(matchId, { isFinished: true });
        return;
      } else {
        // Mauvaise réponse golden point
        lastQuestion.answers.push({
          playerId: userId,
          selectedOption,
          isCorrect: false,
          score: 0,
          answeredAt: new Date(),
        });
        await match.save();

        io.to(matchId).emit("wrong_golden_point_answer", {
          playerId: userId,
          message: "❌ Wrong answer during GOLDEN POINT",
        });

        const totalAnswers = lastQuestion.answers.length;
        const playersCount = match.joinerId ? 2 : 1;
        const allAnswered = totalAnswers >= playersCount;
        const allIncorrect = lastQuestion.answers.every((a) => !a.isCorrect);

        if (allAnswered && allIncorrect) {
          matchTimers.set(matchId, {
            ...matchTimers.get(matchId),
            handled: true,
          });

          io.to(matchId).emit("golden_point_trigger", { matchId });
        }
        return;
      }
    }
    if (isGoldenPoint && isHandled) return;

    // Vérifier si déjà répondu
    const alreadyAnswered = lastQuestion.answers.find(
      (a) => a.playerId.toString() === userId.toString()
    );
    if (alreadyAnswered) return;

    const isCorrect = selectedOption === lastQuestion.question.correctOption;
    const isConversion = lastQuestion.question.isConversion === true;
    const isConversionPlayer =
      isConversion &&
      lastQuestion.question.conversionPlayerId?.toString() ===
        userId.toString();

    const scoreToAdd = isCorrect ? (isConversion ? 2 : 4) : 0;

    lastQuestion.answers.push({
      playerId: userId,
      selectedOption,
      isCorrect,
      score: scoreToAdd,
      answeredAt: new Date(),
    });

    await match.save();

    // Appel IA si match solo
    if (match.isAgainstAI && userId.toString() === match.creatorId.toString()) {
      await makeAIMove(matchId, io);
    }

    // Gestion handled timer
    const currentTimerState = matchTimers.get(matchId);
    if (lastQuestion.answers.length >= (match.joinerId ? 2 : 1)) {
      matchTimers.set(matchId, {
        ...currentTimerState,
        handled: true,
      });
    }

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: userId,
      questionText: lastQuestion.question.text,
      selectedOption,
      isCorrect,
      answeredAt: new Date(),
    });

    // Recalcul des scores
    const freshMatch = await Match.findById(matchId)
      .populate("creatorId")
      .populate("joinerId");

    let scoreUserOne = 0;
    let scoreUserTwo = 0;

    freshMatch.questionsAsked.forEach((q) => {
      q.answers.forEach((a) => {
        if (a.playerId.toString() === freshMatch.creatorId._id.toString()) {
          scoreUserOne += a.score || 0;
        } else if (
          freshMatch.joinerId &&
          a.playerId.toString() === freshMatch.joinerId._id.toString()
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

    // Gestion conversion
    if (isConversion && isConversionPlayer) {
      const teamTitle =
        userId.toString() === match.creatorId.toString()
          ? match.playerOneTeam.title
          : match.playerTwoTeam?.title || "Team";

      io.to(matchId).emit("conversion_result", {
        playerId: userId,
        success: isCorrect,
        message: isCorrect
          ? `${teamTitle} CONVERSION SUCCESSFUL`
          : `${teamTitle} CONVERSION UNSUCCESSFUL`,
      });

      setTimeout(async () => {
        const updatedMatch = await Match.findById(matchId);
        const nextIndex = updatedMatch.questionsAsked.length;

        if (nextIndex >= Quizz.length) {
          updatedMatch.isFinished = true;
          await updatedMatch.save();
          io.to(matchId).emit("match_finished", {
            message: "The quiz is over! Thank you for playing.",
          });
          return;
        }

        const nextQ = Quizz[nextIndex];
        const formattedOptions = Array.isArray(nextQ.choices)
          ? nextQ.choices.reduce((acc, choice, idx) => {
              const letters = ["A", "B", "C", "D"];
              acc[letters[idx]] = choice;
              return acc;
            }, {})
          : nextQ.choices;

        updatedMatch.questionsAsked.push({
          question: {
            text: nextQ.question,
            options: formattedOptions,
            correctOption: nextQ.correctAnswer,
            isConversion: nextQ.isConversion || false,
          },
          answers: [],
        });

        await updatedMatch.save();

        io.to(matchId).emit("next_question", {
          question: {
            text: nextQ.question,
            choices: formattedOptions,
            correctAnswer: nextQ.correctAnswer,
          },
        });
      }, 4000);

      return;
    }

    // Notifications réponses correctes normales (hors conversion)
    if (isCorrect && !isConversion) {
      const teamTitle =
        userId.toString() === match.creatorId.toString()
          ? match.playerOneTeam.title
          : match.playerTwoTeam?.title || "Team";

      io.to(matchId).emit("correct_answer_received", {
        playerId: userId,
        message: `Try ${teamTitle} !`,
      });

      setTimeout(async () => {
        const convQ =
          Quizz.find((q) => q.isConversion) ||
          Quizz[Math.floor(Math.random() * Quizz.length)];

        const formattedConvOptions = Array.isArray(convQ.choices)
          ? convQ.choices.reduce((acc, choice, idx) => {
              const letters = ["A", "B", "C", "D"];
              acc[letters[idx]] = choice;
              return acc;
            }, {})
          : convQ.choices;

        match.questionsAsked.push({
          question: {
            text: convQ.question,
            options: formattedConvOptions,
            correctOption: convQ.correctAnswer,
            isConversion: true,
            conversionPlayerId: userId,
          },
          answers: [],
        });

        await match.save();

        io.to(matchId).emit("conversion_question", {
          playerId: userId,
          question: {
            text: convQ.question,
            choices: formattedConvOptions,
            correctAnswer: convQ.correctAnswer,
          },
        });
      }, 3000);

      return;
    }

    // Passage à la question suivante si tous ont répondu
    if (lastQuestion.answers.length >= 1) {
      setTimeout(async () => {
        const updatedMatch = await Match.findById(matchId);
        const nextIndex = updatedMatch.questionsAsked.length;
        const totalQuestions = Quizz.length;

        const isHalfTime =
          !updatedMatch.halfTimeTriggered &&
          nextIndex >= Math.floor(totalQuestions / 2);

        if (isHalfTime) {
          updatedMatch.halfTimeTriggered = true;
          await updatedMatch.save();

          io.to(matchId).emit("half_time", {
            message: "⏸️ HALF-TIME! Quick break!",
          });

          setTimeout(() => {
            proceedToNextQuestion(matchId);
          }, 5000);
        } else {
          proceedToNextQuestion(matchId);
        }
      }, 1000);
    }
  } catch (error) {
    console.error("❌ Erreur dans handleAnswerQuestion :", error);
  }
}

module.exports = handleAnswerQuestion;
