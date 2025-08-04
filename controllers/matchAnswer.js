const { AI_BOT_USER_ID } = require("../constants");
const Match = require("../models/Match");
const Quizz = require("../models/Quizz");
const matchTimers = new Map();

async function makeAIMove(matchId, io) {
  const match = await Match.findById(matchId);
  if (!match || match.isFinished || !match.quizStarted || !match.isAgainstAI)
    return;

  const lastQuestion = match.questionsAsked.at(-1);
  if (!lastQuestion) return;

  if (lastQuestion.answers.find((a) => a.playerId.equals(AI_BOT_USER_ID)))
    return;

  const aiPlayerId = AI_BOT_USER_ID;
  const isGoldenPoint = matchTimers.get(matchId)?.isGoldenPoint === true;
  const isConversion = lastQuestion.question.isConversion === true;

  // Gestion GOLDEN POINT
  if (isGoldenPoint) {
    const accuracy = match.aiSettings?.accuracyRate ?? 0.7;
    const willAnswerCorrectly = Math.random() < accuracy;
    const selectedOption = willAnswerCorrectly
      ? lastQuestion.question.correctOption
      : Object.keys(lastQuestion.question.options)
          .filter((opt) => opt !== lastQuestion.question.correctOption)
          .sort(() => 0.5 - Math.random())[0];

    await new Promise((resolve) =>
      setTimeout(resolve, match.aiSettings?.responseDelayMs ?? 2000)
    );

    lastQuestion.answers.push({
      playerId: aiPlayerId,
      selectedOption,
      isCorrect: selectedOption === lastQuestion.question.correctOption,
      score: selectedOption === lastQuestion.question.correctOption ? 1 : 0,
      answeredAt: new Date(),
    });

    await match.save();

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: aiPlayerId,
      questionText: lastQuestion.question.text,
      selectedOption,
      isCorrect: selectedOption === lastQuestion.question.correctOption,
      answeredAt: new Date(),
    });

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

    if (selectedOption === lastQuestion.question.correctOption) {
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
    }

    return;
  }

  // Conversion : vérifier si c'est bien au tour de l'IA
  if (
    isConversion &&
    (!lastQuestion.question.conversionPlayerId ||
      !lastQuestion.question.conversionPlayerId.equals(aiPlayerId))
  ) {
    return;
  }

  const accuracy = match.aiSettings?.accuracyRate ?? 0.7;
  const willAnswerCorrectly = Math.random() < accuracy;
  const selectedOption = willAnswerCorrectly
    ? lastQuestion.question.correctOption
    : Object.keys(lastQuestion.question.options)
        .filter((opt) => opt !== lastQuestion.question.correctOption)
        .sort(() => 0.5 - Math.random())[0];

  await new Promise((resolve) =>
    setTimeout(resolve, match.aiSettings?.responseDelayMs ?? 8000)
  );

  const isCorrect = selectedOption === lastQuestion.question.correctOption;
  const score = isCorrect ? (isConversion ? 2 : 4) : 0;

  lastQuestion.answers.push({
    playerId: aiPlayerId,
    selectedOption,
    isCorrect,
    score,
    answeredAt: new Date(),
  });

  await match.save();

  io.to(matchId).emit("answer_question", {
    matchId,
    playerId: aiPlayerId,
    questionText: lastQuestion.question.text,
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

  io.to(matchId).emit("score_updated", { matchId, scoreUserOne, scoreUserTwo });

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

    setTimeout(async () => {
      const updatedMatch = await Match.findById(matchId);
      const nextIndex = updatedMatch.questionsAsked.length;

      if (nextIndex >= Quizz.length) {
        updatedMatch.isFinished = true;
        await updatedMatch.save();
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

      // 👉 L’IA rejoue automatiquement si c’est un match IA
      if (match.isAgainstAI) {
        setTimeout(() => {
          makeAIMove(matchId, io);
        }, 1000);
      }
    }, 1000);

    return;
  }

  // Cas normal : rien à faire, `handleAnswerQuestion` prendra le relais côté joueur
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
        // Laisser le temps à la question d’être reçue, puis refaire jouer l’IA
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

        match.questionsAsked.push(conversionQuestion);
        await match.save();

        io.to(matchId).emit("conversion_question", {
          playerId: userId,
          question: {
            text: convQ.question,
            choices: formattedConvOptions,
            correctAnswer: convQ.correctAnswer,
          },
        });

        // ⚠️ Si c’est l’IA qui a répondu correctement → forcer réponse automatique
        if (userId.toString() === AI_BOT_USER_ID.toString()) {
          // Laisse 1s de délai, puis appel de makeAIMove
          setTimeout(() => {
            makeAIMove(matchId, io);
          }, 1000);
        }
      }, 1000);

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
            proceedToNextQuestion(matchId, io, userId);
          }, 1000);
        } else {
          proceedToNextQuestion(matchId, io, userId);
        }
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
