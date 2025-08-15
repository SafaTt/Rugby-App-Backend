const { AI_BOT_USER_ID } = require("../constants");
const Match = require("../models/Match");
const Quizz = require("../models/Quizz");
const matchTimers = new Map();

function isAI(id) {
  return id && AI_BOT_USER_ID && id.toString() === AI_BOT_USER_ID.toString();
}

function generateConversionQuestion(playerId, originalQuestion) {
  return {
    text: `${originalQuestion.text}`,
    options: originalQuestion.options,
    correctOption: originalQuestion.correctOption,
    isConversion: true,
    conversionPlayerId: playerId,
  };
}

const cleanupMatch = async (matchId, io) => {
  const state = matchTimers.get(matchId);

  // Supprimer tous les timers actifs
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  if (state?.conversionTimeout) {
    clearTimeout(state.conversionTimeout);
  }

  // Supprimer l'état du match
  matchTimers.delete(matchId);

  // Mettre à jour la base si besoin
  const match = await Match.findById(matchId);
  if (match && !match.isFinished) {
    match.isFinished = true;
    match.status = "finished";
    // Annuler tous les timers liés à ce match
    if (timerState.timer) clearTimeout(timerState.timer);
    if (timerState.conversionTimeout)
      clearTimeout(timerState.conversionTimeout);
    if (timerState.waitingSecondPlayerTimeout)
      clearTimeout(timerState.waitingSecondPlayerTimeout);

    matchTimers.delete(matchId);
    await match.save({ optimisticConcurrency: false });
  }

  // Informer les clients et retirer tous les sockets de la room
  io.to(matchId).emit("match_finished", { matchId });
  io.in(matchId).socketsLeave(matchId);

  console.log(`🏁 Cleanup complet pour le match ${matchId}`);
};

function recalcScores(match) {
  let scoreUserOne = 0;
  let scoreUserTwo = 0;

  match.questionsAsked.forEach((q) => {
    q.answers.forEach((a) => {
      if (!match.creatorId || !match.joinerId) return;

      if (a.playerId.toString() === match.creatorId._id.toString()) {
        scoreUserOne += a.score;
      } else if (a.playerId.toString() === match.joinerId._id.toString()) {
        scoreUserTwo += a.score;
      }
    });
  });

  match.scoreUserOne = scoreUserOne;
  match.scoreUserTwo = scoreUserTwo;
}
function getOrInitTimerState(matchId) {
  let state = matchTimers.get(matchId);
  if (!state) {
    state = {
      handled: false,
      pendingConversion: null,
      firstCorrectPlayer: null,
      timer: null,
      conversionTimeout: null,
      isGoldenPoint: false,
      isHalfTime: false,
      halfTimeNextQuestionSent: false,
    };
    matchTimers.set(matchId, state);
  }
  return state;
}

async function makeAIMove(matchId, io) {
  const match = await Match.findById(matchId);
  if (
    !match ||
    match.isFinished ||
    match.leaverId ||
    !match.quizStarted ||
    !match.isAgainstAI
  )
    return;

  const lastQuestion = match.questionsAsked.at(-1);
  if (!lastQuestion) return;

  const aiPlayerId = AI_BOT_USER_ID;

  // déjà répondu ?
  if (lastQuestion.answers.some((a) => a.playerId.equals(aiPlayerId))) return;

  const stateSnap = getOrInitTimerState(matchId);
  if (stateSnap.isHalfTime) return;

  const isGoldenPoint = stateSnap.isGoldenPoint === true;
  const isConversion = lastQuestion.question.isConversion === true;

  // IA répond aux conversions si c’est sa conversion
  if (isConversion) {
    const isConversionPlayer =
      lastQuestion.question.conversionPlayerId?.equals(aiPlayerId);
    if (!isConversionPlayer) return;
  }

  // IA répond au golden point si elle n’a pas encore répondu
  if (
    isGoldenPoint &&
    lastQuestion.answers.some((a) => a.playerId.equals(aiPlayerId))
  )
    return;

  // ⚡ Délai fixe de 6 secondes pour toutes les réponses IA
  const delay = 6000;

  setTimeout(async () => {
    const updatedMatch = await Match.findById(matchId);
    if (!updatedMatch) return;
    const lastQ = updatedMatch.questionsAsked.at(-1);
    if (!lastQ) return;

    const accuracy = updatedMatch.aiSettings?.accuracyRate ?? 0.7;
    const willAnswerCorrectly = Math.random() < accuracy;
    const selectedOption = willAnswerCorrectly
      ? lastQ.question.correctOption
      : Object.keys(lastQ.question.options)
          .filter((opt) => opt !== lastQ.question.correctOption)
          .sort(() => 0.5 - Math.random())[0];

    const isCorrect = selectedOption === lastQ.question.correctOption;
    const score = isCorrect ? (isConversion ? 2 : isGoldenPoint ? 1 : 4) : 0;

    lastQ.answers.push({
      playerId: aiPlayerId,
      selectedOption,
      isCorrect,
      score,
      answeredAt: new Date(),
    });

    recalcScores(updatedMatch);
    await updatedMatch.save({ optimisticConcurrency: false });

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: aiPlayerId,
      questionText: lastQ.question.text,
      selectedOption,
      isCorrect,
      answeredAt: new Date(),
    });

    io.to(matchId).emit("score_updated", {
      matchId,
      scoreUserOne: updatedMatch.scoreUserOne,
      scoreUserTwo: updatedMatch.scoreUserTwo,
    });

    const stateNow = getOrInitTimerState(matchId);
    const allAnswered = lastQ.answers.length >= (updatedMatch.joinerId ? 2 : 1);
    const allIncorrect = lastQ.answers.every((a) => !a.isCorrect);

    // Si c'est une question normale et la réponse est correcte
    if (!isConversion && isCorrect) {
      const stateNow = getOrInitTimerState(matchId);
      if (stateNow.timer) clearTimeout(stateNow.timer);
      stateNow.firstCorrectPlayer = aiPlayerId;

      // ⚡ Marquer la conversion comme pending
      stateNow.pendingConversion = {
        question: generateConversionQuestion(aiPlayerId, lastQ.question),
      };

      matchTimers.set(matchId, stateNow);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io); // injectera la conversion
      return;
    }

    // ⚡ Si c’est une conversion, IA répond → passe directement à la prochaine question
    if (isConversion) {
      const stateNow = getOrInitTimerState(matchId);
      if (stateNow.timer) clearTimeout(stateNow.timer);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io);
      return;
    }

    if (allAnswered && allIncorrect) {
      if (stateNow.timer) clearTimeout(stateNow.timer);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io);
      return;
    }

    if (!isCorrect && lastQ.answers.length === 1) {
      if (!stateNow.timer) {
        const t = setTimeout(async () => {
          markHandled(matchId);
          await proceedToNextQuestion(matchId, io);
        }, 10000);
        matchTimers.set(matchId, { ...stateNow, timer: t });
      }
    }
  }, delay);
}

async function handleAnswerQuestion({ matchId, userId, selectedOption, io }) {
  try {
    const match = await Match.findById(matchId)
      .populate("creatorId")
      .populate("joinerId");
    if (!match || match.isFinished) return;

    const lastQuestion = match.questionsAsked.at(-1);
    if (!lastQuestion) return;

    const responderId = isAI(userId) ? AI_BOT_USER_ID : userId;

    // Déjà répondu ?
    const alreadyAnswered = lastQuestion.answers.some(
      (a) => a.playerId.toString() === responderId.toString()
    );
    if (alreadyAnswered) return;

    const isConversion = lastQuestion.question.isConversion === true;
    const isGoldenPoint = getOrInitTimerState(matchId).isGoldenPoint;

    // ⚡ Score correct : +2 pour conversion, +4 sinon, +1 pour golden point
    let addScore = 0;
    if (isCorrect(selectedOption, lastQuestion.question)) {
      if (isConversion) addScore = 2;
      else if (isGoldenPoint) addScore = 1;
      else addScore = 4;
    }

    lastQuestion.answers.push({
      playerId: responderId,
      selectedOption,
      isCorrect: isCorrect(selectedOption, lastQuestion.question),
      score: addScore,
      answeredAt: new Date(),
    });

    // Mise à jour des scores
    recalcScores(match);
    await match.save({ optimisticConcurrency: false });

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: responderId,
      questionText: lastQuestion.question.text,
      selectedOption,
      isCorrect: isCorrect(selectedOption, lastQuestion.question),
      answeredAt: new Date(),
    });

    io.to(matchId).emit("score_updated", {
      matchId,
      scoreUserOne: match.scoreUserOne,
      scoreUserTwo: match.scoreUserTwo,
    });

    const stateNow = getOrInitTimerState(matchId);
    const allAnswered = lastQuestion.answers.length >= (match.joinerId ? 2 : 1);
    const allIncorrect = lastQuestion.answers.every((a) => !a.isCorrect);

    // ⚡ Si question normale et réponse correcte → déclenchement conversion
    if (!isConversion && isCorrect(selectedOption, lastQuestion.question)) {
      if (stateNow.timer) clearTimeout(stateNow.timer);
      stateNow.firstCorrectPlayer = responderId;
      stateNow.pendingConversion = {
        question: generateConversionQuestion(
          responderId,
          lastQuestion.question
        ),
      };
      matchTimers.set(matchId, stateNow);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io); // injectera la conversion
      return;
    }

    // ⚡ Si question conversion ou réponse incorrecte après tout le monde → prochaine question
    if (isConversion || (allAnswered && allIncorrect)) {
      if (stateNow.timer) clearTimeout(stateNow.timer);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io);
      return;
    }

    // ⚡ Timer pour réponse unique incorrecte
    if (
      !isCorrect(selectedOption, lastQuestion.question) &&
      lastQuestion.answers.length === 1
    ) {
      if (!stateNow.timer) {
        const t = setTimeout(async () => {
          markHandled(matchId);
          await proceedToNextQuestion(matchId, io);
        }, 10000);
        matchTimers.set(matchId, { ...stateNow, timer: t });
      }
    }

    // ⚡ Fin du match → vérifier égalité pour Golden Point
    if (
      !getOrInitTimerState(matchId).isGoldenPoint &&
      match.questionsAsked.length >= Quizz.length
    ) {
      if (match.scoreUserOne === match.scoreUserTwo) {
        stateNow.isGoldenPoint = true;
        matchTimers.set(matchId, stateNow);
        io.to(matchId).emit("golden_point_start", {
          message: "🏅 Égalité ! Golden Point lancé.",
        });
        await proceedToNextQuestion(matchId, io, { goldenPoint: true });
      } else {
        await cleanupMatch(matchId, io);
      }
    }
  } catch (error) {
    console.error("❌ Erreur handleAnswerQuestion :", error);
  }
}

function isCorrect(selectedOption, question) {
  return selectedOption === question.correctOption;
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
    matchTimers.set(matchId, { ...current, handled: true });
  }
};

const proceedToNextQuestion = async (matchId, io, options = {}) => {
  const match = await Match.findById(matchId);
  if (!match || match.isFinished || !match.quizStarted) return;

  const timerState = matchTimers.get(matchId) || {};
  const stateNow = getOrInitTimerState(matchId);

  // ⚡ Half-time automatique
  const totalQuestionsBeforeHalfTime = Math.ceil(Quizz.length / 2);
  if (
    !stateNow.halfTimeTriggered &&
    match.questionsAsked.length >= totalQuestionsBeforeHalfTime
  ) {
    stateNow.isHalfTime = true;
    stateNow.halfTimeTriggered = true;
    if (stateNow.timer) clearTimeout(stateNow.timer);
    matchTimers.set(matchId, stateNow);

    io.to(matchId).emit("half_time", {
      message: "⏸️ Half-time! Take a short break.",
    });

    setTimeout(async () => {
      const updatedState = matchTimers.get(matchId) || {};
      updatedState.isHalfTime = false;
      matchTimers.set(matchId, updatedState);
      await proceedToNextQuestion(matchId, io, { afterHalfTime: true });
    }, 5000);

    return;
  }

  // ⚡ Conversion en attente
  if (timerState.pendingConversion) {
    const alreadyInjected = match.questionsAsked.some(
      (q) =>
        q.question.isConversion &&
        q.question.conversionPlayerId?.toString() ===
          timerState.pendingConversion.question.conversionPlayerId?.toString()
    );

    if (!timerState.conversionTimeout && !alreadyInjected) {
      const convQuestion = timerState.pendingConversion;
      convQuestion.question.isConversion = true;

      match.questionsAsked.push(convQuestion);
      await match.save({ optimisticConcurrency: false });

      io.to(matchId).emit("conversion_question", {
        playerId: convQuestion.question.conversionPlayerId,
        question: {
          text: convQuestion.question.text,
          choices: convQuestion.question.options,
          correctAnswer: convQuestion.question.correctOption,
        },
      });

      // ⏱️ Timer conversion 10s
      const conversionTimeout = setTimeout(async () => {
        const state = matchTimers.get(matchId) || {};
        if (state?.pendingConversion) {
          delete state.pendingConversion;
          delete state.conversionTimeout;
          markHandled(matchId);
          matchTimers.set(matchId, state);
          await proceedToNextQuestion(matchId, io, options);
        }
      }, 10000); // ← Persistance 10 secondes

      matchTimers.set(matchId, {
        ...timerState,
        conversionTimeout,
        handled: false,
      });

      // ⚡ IA joue immédiatement si c’est sa conversion
      if (match.isAgainstAI) makeAIMove(matchId, io);

      return;
    }
  }

  // Nouvelle question normale
  const nextQ = getRandomQuestion(Quizz, match.questionsAsked);
  if (!nextQ) {
    await cleanupMatch(matchId, io);
    console.log("🏁 Fin du match, plus de questions dispo");
    return;
  }

  const formattedOptions = Array.isArray(nextQ.choices)
    ? nextQ.choices.reduce((acc, choice, idx) => {
        const letters = ["A", "B", "C", "D"];
        acc[letters[idx]] = choice;
        return acc;
      }, {})
    : nextQ.choices;

  const newQuestion = {
    question: {
      text: nextQ.question,
      options: formattedOptions,
      correctOption: nextQ.correctAnswer,
      isConversion: false,
      conversionPlayerId: null,
    },
    answers: [],
  };
  match.questionsAsked.push(newQuestion);
  await match.save({ optimisticConcurrency: false });

  io.to(matchId).emit("next_question", {
    question: {
      text: nextQ.question,
      choices: formattedOptions,
      correctAnswer: nextQ.correctAnswer,
    },
  });

  // ⚡ Mode solo : IA joue immédiatement
  if (match.isAgainstAI) makeAIMove(matchId, io);

  // Timer normal
  if (timerState.timer) clearTimeout(timerState.timer);
  const timer = setTimeout(() => {
    const state = matchTimers.get(matchId);
    if (!state?.handled) {
      markHandled(matchId);
      proceedToNextQuestion(matchId, io, options);
    }
  }, 10000);

  matchTimers.set(matchId, {
    timer,
    handled: false,
    pendingConversion: null,
    firstCorrectPlayer: null,
  });
};

module.exports = handleAnswerQuestion;
