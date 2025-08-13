const { AI_BOT_USER_ID } = require("../constants");
const Match = require("../models/Match");
const Quizz = require("../models/Quizz");
const matchTimers = new Map();

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

  const stateSnap = getOrInitTimerState(matchId); // snapshot initial
  if (stateSnap.isHalfTime) return;

  const isGoldenPoint = stateSnap.isGoldenPoint === true;
  const isConversion = lastQuestion.question.isConversion === true;

  // conversion : l’IA ne répond que si c’est sa conversion et si l’humain n’a pas déjà répondu
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

  const delay =
    match.aiSettings?.responseDelayMs ?? (isGoldenPoint ? 6000 : 8000);

  setTimeout(async () => {
    const updatedMatch = await Match.findById(matchId);
    if (!updatedMatch) return;
    const lastQ = updatedMatch.questionsAsked.at(-1);
    if (!lastQ) return;

    const isCorrect = selectedOption === lastQ.question.correctOption;
    const score = isCorrect ? (isConversion ? 2 : isGoldenPoint ? 1 : 4) : 0;

    lastQ.answers.push({
      playerId: aiPlayerId,
      selectedOption,
      isCorrect,
      score,
      answeredAt: new Date(),
    });

    // scores incrémentaux
    if (!updatedMatch.scoreUserOne) updatedMatch.scoreUserOne = 0;
    if (!updatedMatch.scoreUserTwo) updatedMatch.scoreUserTwo = 0;
    if (aiPlayerId.toString() === updatedMatch.creatorId._id.toString()) {
      updatedMatch.scoreUserOne += score;
    } else if (
      updatedMatch.joinerId &&
      aiPlayerId.toString() === updatedMatch.joinerId._id.toString()
    ) {
      updatedMatch.scoreUserTwo += score;
    }

    await updatedMatch.save();

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

    // logique d’enchaînement
    const stateNow = getOrInitTimerState(matchId); // ⚠️ relire l’état à l’instant T
    const allAnswered = lastQ.answers.length >= (updatedMatch.joinerId ? 2 : 1);
    const allIncorrect = lastQ.answers.every((a) => !a.isCorrect);

    if (!isConversion && isCorrect) {
      // réponse correcte → conversion immédiate
      if (stateNow.timer) clearTimeout(stateNow.timer);
      stateNow.firstCorrectPlayer = aiPlayerId;
      matchTimers.set(matchId, stateNow);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io);
      return;
    }

    if (allAnswered && allIncorrect) {
      // deux réponses fausses → next immédiat
      if (stateNow.timer) clearTimeout(stateNow.timer);
      markHandled(matchId);
      await proceedToNextQuestion(matchId, io);
      return;
    }

    if (!isCorrect && lastQ.answers.length === 1) {
      // une seule réponse fausse → attendre 10s
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

// Vérifie si un ID est celui de l'IA
function isAI(id) {
  return id && AI_BOT_USER_ID && id.toString() === AI_BOT_USER_ID.toString();
}

async function handleAnswerQuestion({ matchId, userId, selectedOption, io }) {
  try {
    const match = await Match.findById(matchId)
      .populate("creatorId")
      .populate("joinerId");
    if (!match || match.isFinished) return;

    const lastQuestion = match.questionsAsked.at(-1);
    if (!lastQuestion) return;

    // On garde l'ObjectId correct pour savoir qui répond
    const responderId = isAI(userId) ? AI_BOT_USER_ID : userId;

    // déjà répondu ?
    const alreadyAnswered = lastQuestion.answers.some(
      (a) => a.playerId.toString() === responderId.toString()
    );
    if (alreadyAnswered) return;

    const isCorrect = selectedOption === lastQuestion.question.correctOption;
    const isConversion = lastQuestion.question.isConversion === true;
    const addScore = isCorrect ? (isConversion ? 2 : 4) : 0;

    lastQuestion.answers.push({
      playerId: responderId,
      selectedOption,
      isCorrect,
      score: addScore,
      answeredAt: new Date(),
    });

    // Mise à jour des scores
    if (!match.scoreUserOne) match.scoreUserOne = 0;
    if (!match.scoreUserTwo) match.scoreUserTwo = 0;

    if (responderId.toString() === match.creatorId._id.toString()) {
      match.scoreUserOne += addScore;
    } else if (
      match.joinerId &&
      responderId.toString() === match.joinerId._id.toString()
    ) {
      match.scoreUserTwo += addScore;
    }

    await match.save();

    io.to(matchId).emit("answer_question", {
      matchId,
      playerId: responderId,
      questionText: lastQuestion.question.text,
      selectedOption,
      isCorrect,
      answeredAt: new Date(),
    });

    io.to(matchId).emit("score_updated", {
      matchId,
      scoreUserOne: match.scoreUserOne,
      scoreUserTwo: match.scoreUserTwo,
    });

    // Gestion des enchaînements (inchangée)
    const stateNow = getOrInitTimerState(matchId);
    const allAnswered = lastQuestion.answers.length >= (match.joinerId ? 2 : 1);
    const allIncorrect = lastQuestion.answers.every((a) => !a.isCorrect);

    if (!isConversion && isCorrect) {
      if (stateNow.timer) clearTimeout(stateNow.timer);
      stateNow.firstCorrectPlayer = responderId;
      matchTimers.set(matchId, stateNow);
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

    if (!isCorrect && lastQuestion.answers.length === 1) {
      if (!stateNow.timer) {
        const t = setTimeout(async () => {
          markHandled(matchId);
          await proceedToNextQuestion(matchId, io);
        }, 10000);
        matchTimers.set(matchId, { ...stateNow, timer: t });
      }
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

const proceedToNextQuestion = async (matchId, io, options = {}) => {
  const match = await Match.findById(matchId);
  if (!match || match.isFinished || !match.quizStarted) return;

  const timerState = matchTimers.get(matchId) || {};
  let justInjectedConversion = false;

  // Bloquer si golden point actif
  if (timerState.isGoldenPoint && !timerState.handled) return;

  // Bloquer l’injection multiple après half-time
  if (options.afterHalfTime && timerState.halfTimeNextQuestionSent) return;
  if (options.afterHalfTime) {
    matchTimers.set(matchId, { ...timerState, halfTimeNextQuestionSent: true });
  }

  // ⚡ Conversion en attente
  if (timerState.pendingConversion) {
    // Vérifier si la question de conversion n’a pas déjà été injectée
    const alreadyInjected = match.questionsAsked.some(
      (q) =>
        q.question.isConversion &&
        q.question.conversionPlayerId?.toString() ===
          timerState.pendingConversion.question.conversionPlayerId?.toString()
    );
    if (!timerState.conversionTimeout && !alreadyInjected) {
      const convQuestion = timerState.pendingConversion;

      // Sécuriser les champs
      convQuestion.question.text ||= "MISSING_TEXT";
      convQuestion.question.options ||= {};
      convQuestion.question.correctOption ||= null;
      convQuestion.question.isConversion = true;

      match.questionsAsked.push(convQuestion);
      await match.save();
      justInjectedConversion = true;

      if (timerState.timer) clearTimeout(timerState.timer);

      io.to(matchId).emit("conversion_question", {
        playerId: convQuestion.question.conversionPlayerId,
        question: {
          text: convQuestion.question.text,
          choices: convQuestion.question.options,
          correctAnswer: convQuestion.question.correctOption,
        },
      });

      const conversionTimeout = setTimeout(async () => {
        const state = matchTimers.get(matchId) || {};
        if (state?.pendingConversion) {
          delete state.pendingConversion;
          delete state.conversionTimeout;
          markHandled(matchId);
          matchTimers.set(matchId, state);
          await proceedToNextQuestion(matchId, io, options);
        }
      }, 10000);

      matchTimers.set(matchId, {
        ...timerState,
        conversionTimeout,
        handled: false,
      });
      console.log("⏳ Conversion injectée, timer 10s lancé");
      return;
    }
  }

  // Nouvelle question normale
  const nextQ = getRandomQuestion(Quizz, match.questionsAsked);
  if (!nextQ) {
    match.isFinished = true;
    match.status = "finished";
    await match.save();
    io.to(matchId).emit("match_finished", { matchId });
    io.in(matchId).socketsLeave(matchId);
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

  const lastQuestionIndex = match.questionsAsked.length - 1;
  const previousQuestion =
    lastQuestionIndex >= 0 ? match.questionsAsked[lastQuestionIndex] : null;

  let launchConversion = false;
  let playerIdToConvert = null;

  if (
    previousQuestion &&
    !justInjectedConversion &&
    !previousQuestion.question.isConversion
  ) {
    if (timerState.firstCorrectPlayer) {
      launchConversion = true;
      playerIdToConvert = timerState.firstCorrectPlayer;
    }
  }

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

  // ⚡ Conversion immédiate si joueur correct
  if (launchConversion) {
    matchTimers.set(matchId, {
      ...timerState,
      pendingConversion: {
        question: {
          ...newQuestion.question,
          isConversion: true,
          conversionPlayerId: playerIdToConvert,
        },
        answers: [],
      },
      handled: false,
    });
    return await proceedToNextQuestion(matchId, io, options); // récursif pour injecter conversion
  }

  // Sinon on ajoute la question normale
  match.questionsAsked.push(newQuestion);
  await match.save();

  if (timerState.timer) clearTimeout(timerState.timer);

  io.to(matchId).emit("next_question", {
    question: {
      text: nextQ.question,
      choices: formattedOptions,
      correctAnswer: nextQ.correctAnswer,
    },
  });

  // ⚡ Mode solo : on fait jouer l'AI après la question
  if (match.isAgainstAI) makeAIMove(matchId, io);
  console.log("🧭 Timer lancé pour une nouvelle question normale");

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
