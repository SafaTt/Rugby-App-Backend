const { AI_BOT_USER_ID } = require("../constants");
const Match = require("../models/Match");
const Quizz = require("../models/Quizz");
const matchTimers = new Map();

async function makeAIMove(matchId, io) {
  const match = await Match.findById(matchId);
  if (!match || match.isFinished || !match.quizStarted || !match.isAgainstAI)
    return;

  // Vérifier pause half-time
  const timerState = matchTimers.get(matchId);
  if (timerState?.isHalfTime) return;

  const lastQuestion = match.questionsAsked.at(-1);
  if (!lastQuestion) return;

  const aiPlayerId = AI_BOT_USER_ID;

  // IA a déjà répondu ?
  if (lastQuestion.answers.some((a) => a.playerId.equals(aiPlayerId))) return;

  const isGoldenPoint = timerState?.isGoldenPoint === true;
  const isConversion = lastQuestion.question.isConversion === true;

  // Conversion : vérifier si l'IA doit répondre
  if (isConversion) {
    const humanAnswered = lastQuestion.answers.some(
      (a) => !a.playerId.equals(aiPlayerId)
    );
    const isConversionPlayer =
      lastQuestion.question.conversionPlayerId?.equals(aiPlayerId);
    if (humanAnswered || !isConversionPlayer) return;
  }

  const accuracy = match.aiSettings?.accuracyRate ?? 0.7;
  const willAnswerCorrectly = Math.random() < accuracy;
  const selectedOption = willAnswerCorrectly
    ? lastQuestion.question.correctOption
    : Object.keys(lastQuestion.question.options)
        .filter((opt) => opt !== lastQuestion.question.correctOption)
        .sort(() => 0.5 - Math.random())[0];

  // Vérifier half-time juste avant de répondre
  const delay =
    match.aiSettings?.responseDelayMs ?? (isGoldenPoint ? 6000 : 8000);
  await new Promise((resolve) => setTimeout(resolve, delay));

  if (matchTimers.get(matchId)?.isHalfTime) return;

  const updatedMatch = await Match.findById(matchId);
  if (!updatedMatch) return;

  const lastQuestionUpdated = updatedMatch.questionsAsked.at(-1);
  if (!lastQuestionUpdated) return;

  const isCorrect =
    selectedOption === lastQuestionUpdated.question.correctOption;
  const score = isCorrect ? (isConversion ? 2 : isGoldenPoint ? 1 : 4) : 0;

  lastQuestionUpdated.answers.push({
    playerId: aiPlayerId,
    selectedOption,
    isCorrect,
    score,
    answeredAt: new Date(),
  });

  await updatedMatch.save();

  io.to(matchId).emit("answer_question", {
    matchId,
    playerId: aiPlayerId,
    questionText: lastQuestionUpdated.question.text,
    selectedOption,
    isCorrect,
    answeredAt: new Date(),
  });

  const freshMatch = await Match.findById(matchId)
    .populate("creatorId")
    .populate("joinerId");

  let scoreUserOne = 0;
  let scoreUserTwo = 0;
  freshMatch.questionsAsked.forEach((q) => {
    q.answers.forEach((a) => {
      if (a.playerId.equals(freshMatch.creatorId._id)) {
        scoreUserOne += a.score || 0;
      } else if (
        freshMatch.joinerId &&
        a.playerId.equals(freshMatch.joinerId._id)
      ) {
        scoreUserTwo += a.score || 0;
      }
    });
  });

  io.to(matchId).emit("score_updated", { matchId, scoreUserOne, scoreUserTwo });

  // Cas GOLDEN POINT gagné
  if (isGoldenPoint && isCorrect) {
    io.to(matchId).emit("golden_point_winner", {
      winnerId: aiPlayerId,
      message: "🏆 GOLDEN POINT! The AI answered correctly!",
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
  }

  // Cas CONVERSION
  if (isConversion) {
    const teamTitle =
      aiPlayerId.toString() === match.creatorId.toString()
        ? match.playerOneTeam.title
        : match.playerTwoTeam?.title || "Team";

    io.to(matchId).emit("conversion_result", {
      playerId: aiPlayerId,
      success: isCorrect,
      message: isCorrect
        ? `${teamTitle} CONVERSION SUCCESSFUL`
        : `${teamTitle} CONVERSION UNSUCCESSFUL`,
    });

    // Attendre puis passer à la prochaine question
    setTimeout(async () => {
      if (matchTimers.get(matchId)?.isHalfTime) return;

      const updatedMatch2 = await Match.findById(matchId);
      const nextIndex = updatedMatch2.questionsAsked.length;

      if (nextIndex >= Quizz.length) {
        updatedMatch2.isFinished = true;
        await updatedMatch2.save();
        io.to(matchId).emit("match_finished", {
          message: "The quiz is over! Thank you for playing.",
        });
        io.in(matchId).socketsLeave(matchId);
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

      updatedMatch2.questionsAsked.push({
        question: {
          text: nextQ.question,
          options: formattedOptions,
          correctOption: nextQ.correctAnswer,
          isConversion: nextQ.isConversion || false,
        },
        answers: [],
      });

      await updatedMatch2.save();

      io.to(matchId).emit("next_question", {
        question: {
          text: nextQ.question,
          choices: formattedOptions,
          correctAnswer: nextQ.correctAnswer,
        },
      });

      if (match.isAgainstAI) {
        setTimeout(() => {
          if (!matchTimers.get(matchId)?.isHalfTime) {
            makeAIMove(matchId, io);
          }
        }, 1000);
      }
    }, 1000);

    return;
  }
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
        // 🔁 Recharge pour éviter conflits version
        const updatedMatch = await Match.findById(matchId);
        if (!updatedMatch) return;
        const lastQuestionUpdated = updatedMatch.questionsAsked.at(-1);
        if (!lastQuestionUpdated) return;

        const score = 1; // Ou calcul approprié pour golden point

        lastQuestionUpdated.answers.push({
          playerId: userId,
          selectedOption,
          isCorrect,
          score,
          answeredAt: new Date(),
        });

        await updatedMatch.save();

        // Recalcul scores sur updatedMatch
        let scoreUserOne = 0;
        let scoreUserTwo = 0;
        updatedMatch.questionsAsked.forEach((q) => {
          q.answers.forEach((a) => {
            if (
              a.playerId.toString() === updatedMatch.creatorId._id.toString()
            ) {
              scoreUserOne += a.score || 0;
            } else if (
              updatedMatch.joinerId &&
              a.playerId.toString() === updatedMatch.joinerId._id.toString()
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

    // 🔁 Recharger match avant modification
    const updatedMatch = await Match.findById(matchId);
    if (!updatedMatch) return;
    const lastQuestionUpdated = updatedMatch.questionsAsked.at(-1);
    if (!lastQuestionUpdated) return;

    lastQuestionUpdated.answers.push({
      playerId: userId,
      selectedOption,
      isCorrect,
      score: scoreToAdd,
      answeredAt: new Date(),
    });

    await updatedMatch.save();

    // Gestion handled timer
    const currentTimerState = matchTimers.get(matchId);
    if (lastQuestionUpdated.answers.length >= (updatedMatch.joinerId ? 2 : 1)) {
      matchTimers.set(matchId, {
        ...currentTimerState,
        handled: true,
      });
    }

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: userId,
      questionText: lastQuestionUpdated.question.text,
      selectedOption,
      isCorrect,
      answeredAt: new Date(),
    });

    // Recalcul scores sur updatedMatch
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

    // Gestion conversion (si conversion et joueur concerné)
    if (isConversion && isConversionPlayer) {
      const teamTitle =
        userId.toString() === freshMatch.creatorId._id.toString()
          ? freshMatch.playerOneTeam.title
          : freshMatch.playerTwoTeam?.title || "Team";

      io.to(matchId).emit("conversion_result", {
        playerId: userId,
        success: isCorrect,
        message: isCorrect
          ? `${teamTitle} CONVERSION SUCCESSFUL`
          : `${teamTitle} CONVERSION UNSUCCESSFUL`,
      });

      setTimeout(async () => {
        const updatedMatch2 = await Match.findById(matchId);
        const nextIndex = updatedMatch2.questionsAsked.length;

        if (nextIndex >= Quizz.length) {
          updatedMatch2.isFinished = true;
          await updatedMatch2.save();
          io.in(matchId).socketsLeave(matchId);
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

        updatedMatch2.questionsAsked.push({
          question: {
            text: nextQ.question,
            options: formattedOptions,
            correctOption: nextQ.correctAnswer,
            isConversion: nextQ.isConversion || false,
          },
          answers: [],
        });

        await updatedMatch2.save();

        io.to(matchId).emit("next_question", {
          question: {
            text: nextQ.question,
            choices: formattedOptions,
            correctAnswer: nextQ.correctAnswer,
          },
        });

        if (match.isAgainstAI) {
          setTimeout(() => {
            makeAIMove(matchId, io);
          }, 1000);
        }
      }, 1000);

      return;
    }

    // Notifications réponses correctes normales (hors conversion)
    if (isCorrect && !isConversion) {
      const teamTitle =
        userId.toString() === freshMatch.creatorId._id.toString()
          ? freshMatch.playerOneTeam.title
          : freshMatch.playerTwoTeam?.title || "Team";

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

        const conversionQuestion = {
          question: {
            text: convQ.question,
            options: formattedConvOptions,
            correctOption: convQ.correctAnswer,
            isConversion: true,
            conversionPlayerId: userId,
          },
          answers: [],
        };

        freshMatch.questionsAsked.push(conversionQuestion);
        await freshMatch.save();

        io.to(matchId).emit("conversion_question", {
          playerId: userId,
          question: {
            text: convQ.question,
            choices: formattedConvOptions,
            correctAnswer: convQ.correctAnswer,
          },
        });

        if (userId.toString() === AI_BOT_USER_ID.toString()) {
          setTimeout(() => {
            makeAIMove(matchId, io);
          }, 1000);
        }
      }, 1000);

      return;
    }

    // Passage à la question suivante si tous ont répondu
    if (lastQuestionUpdated.answers.length >= 1) {
      setTimeout(async () => {
        proceedToNextQuestion(matchId, io, userId);
      }, 1000);
    }
  } catch (error) {
    console.error("❌ Erreur dans handleAnswerQuestion :", error);
  }
}

const getRandomQuestion = (quizzList, alreadyAsked) => {
  const notAsked = quizzList.filter(
    (q) => !alreadyAsked.some((asked) => asked.question.text === q.question)
  );
  if (notAsked.length === 0) return null;
  const index = Math.floor(Math.random() * notAsked.length);
  return notAsked[index];
};

const markHandled = (matchId) => {
  const current = matchTimers.get(matchId);
  if (current) {
    console.log(`🔒 handled=true pour matchId=${matchId}`);
    matchTimers.set(matchId, {
      ...current,
      handled: true,
    });
  } else {
    console.log(
      `⚠️ markHandled appelé mais aucun timer trouvé pour matchId=${matchId}`
    );
  }
};
const proceedToNextQuestion = async (matchId, io, userId) => {
  const match = await Match.findById(matchId);
  if (!match || match.isFinished || !match.quizStarted) {
    console.log("🚫 Match non valide pour continuer la partie");
    return;
  }

  let justInjectedConversion = false;
  const timerState = matchTimers.get(matchId);

  // Si conversion en attente, on l'injecte
  if (timerState?.pendingConversion) {
    const convQuestion = timerState.pendingConversion;

    convQuestion.question.text = convQuestion.question.text || "MISSING_TEXT";
    convQuestion.question.options = convQuestion.question.options || {};
    convQuestion.question.correctOption =
      convQuestion.question.correctOption || null;
    convQuestion.question.isConversion = true;

    match.questionsAsked.push(convQuestion);
    await match.save();
    justInjectedConversion = true;

    if (timerState.timer) clearTimeout(timerState.timer);
    matchTimers.set(matchId, {
      ...timerState,
      handled: true,
      pendingConversion: null,
    });

    console.log("🔁 Conversion injectée par timeout");
    // On continue la suite (sans return ici)
  }

  // Nouvelle question normale
  const next = getRandomQuestion(Quizz, match.questionsAsked);
  if (!next) {
    match.isFinished = true;
    await match.save();
    io.to(matchId).emit("match_finished", { matchId });
    io.in(matchId).socketsLeave(matchId);

    console.log("🏁 Fin du match, plus de questions dispo");
    return;
  }

  const formatted = Array.isArray(next.choices)
    ? next.choices.reduce((acc, choice, idx) => {
        const letters = ["A", "B", "C", "D"];
        acc[letters[idx]] = choice;
        return acc;
      }, {})
    : next.choices;

  const lastQuestionIndex = match.questionsAsked.length - 1;
  const previousQuestion =
    lastQuestionIndex >= 0 ? match.questionsAsked[lastQuestionIndex] : null;

  // Détecter si on doit lancer une conversion
  let launchConversion = false;
  let playerIdToConvert = null;

  if (
    previousQuestion &&
    !justInjectedConversion &&
    !previousQuestion.question.isConversion
  ) {
    const state = matchTimers.get(matchId);
    if (state?.firstCorrectPlayer) {
      launchConversion = true;
      playerIdToConvert = state.firstCorrectPlayer;
    }
  }

  const newQuestion = {
    question: {
      text: next.question,
      options: formatted,
      correctOption: next.correctAnswer,
      isConversion: false,
      conversionPlayerId: null,
    },
    answers: [],
  };

  if (launchConversion) {
    io.to(matchId.toString()).emit("conversion_question", {
      playerId: playerIdToConvert,
      question: {
        text: next.question,
        choices: formatted,
        correctAnswer: next.correctAnswer,
      },
    });

    // Clear ancien timer
    if (matchTimers.has(matchId)) {
      const old = matchTimers.get(matchId);
      if (old?.timer) clearTimeout(old.timer);
    }

    // Timer conversion 10s
    const timer = setTimeout(async () => {
      const refreshedMatch = await Match.findById(matchId);
      if (refreshedMatch?.isFinished) return;

      const state = matchTimers.get(matchId);
      if (!state?.handled) {
        console.log("Etat au timeout :", state);

        console.log(
          "⏱️ Timeout conversion : aucune réponse → passer à la question suivante"
        );
        markHandled(matchId);
        proceedToNextQuestion(matchId, io, userId);
      }
    }, 10000);

    matchTimers.set(matchId, {
      timer,
      handled: false,
      pendingConversion: {
        question: {
          text: next.question,
          options: formatted,
          correctOption: next.correctAnswer,
          isConversion: true,
          conversionPlayerId: playerIdToConvert,
        },
        answers: [],
      },
    });

    return; // On attend la conversion avant d'envoyer une question normale suivante
  }

  // Sinon on ajoute la question normale
  match.questionsAsked.push(newQuestion);
  await match.save();

  // Nettoyer ancien timer s’il existe
  const prev = matchTimers.get(matchId);
  if (prev?.timer) clearTimeout(prev.timer);

  io.to(matchId).emit("next_question", {
    question: {
      text: next.question,
      choices: formatted,
      correctAnswer: next.correctAnswer,
    },
  });
  await makeAIMove(matchId, io);

  // Lancer timer après avoir émis la question
  console.log("🧭 Timer lancé pour une nouvelle question normale");

  const timer = setTimeout(() => {
    console.log("🔔 Timer terminé, vérification handled...");
    const state = matchTimers.get(matchId);
    if (!state?.handled) {
      markHandled(matchId);
      proceedToNextQuestion(matchId, io, userId);
    }
  }, 10000);

  // ✅ Mise à jour *complète* et *unique*
  matchTimers.set(matchId, {
    timer,
    handled: false,
    pendingConversion: null,
    firstCorrectPlayer: null,
  });
};

module.exports = handleAnswerQuestion;
