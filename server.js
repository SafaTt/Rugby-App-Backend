const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const socketIo = require("socket.io");
const http = require("http");
const { AI_BOT_USER_ID } = require("./constants");
const dotenv = require("dotenv");
const authRoutes = require("./routers/authRoutes");
const matchRoutes = require("./routers/matchRoutes");
const dashboardRoutes = require("./routers/dashboardRoutes");
const Match = require("./models/Match");
const Quizz = require("./models/Quizz");
const { log } = require("console");
const { getRandomQuestion, simulateAIAnswer } = require("./utils/AI_matches");

// const { startMatchCleaner } = require("./utils/matchCleaner");
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use("/api/auth", authRoutes);
app.use("/api/match", matchRoutes);
app.use("/api/dashboard", dashboardRoutes);
const server = http.createServer(app);
const matchTimers = new Map();
const readyPlayers = new Map();

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT"],
  },
});

const port = process.env.PORT || 5000;

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.log("Error connecting to MongoDB", err));

// Define routes
app.get("/", (req, res) => {
  res.send("Welcome to the backend!");
});
app.set("io", io);

const updateScores = async (matchId) => {
  const match = await Match.findById(matchId)
    .populate("creatorId")
    .populate("joinerId");

  if (!match) return;

  let scoreUserOne = 0;
  let scoreUserTwo = 0;

  match.questionsAsked.forEach((q) => {
    q.answers.forEach((a) => {
      const pid = a.playerId.toString();
      const isConversion = q.question.isConversion || false;
      const points = a.score || (a.isCorrect ? (isConversion ? 2 : 4) : 0);

      if (pid === match.creatorId._id.toString()) scoreUserOne += points;
      else if (match.joinerId && pid === match.joinerId._id.toString())
        scoreUserTwo += points;
    });
  });

  io.to(matchId).emit("score_updated", {
    matchId,
    scoreUserOne,
    scoreUserTwo,
  });

  return { scoreUserOne, scoreUserTwo };
};

async function launchGoldenPointQuestion(matchId) {
  // Nettoyer l'ancien timer s'il existe
  const existing = matchTimers.get(matchId);
  if (existing?.timer) clearTimeout(existing.timer);

  const match = await Match.findById(matchId)
    .populate("creatorId")
    .populate("joinerId");

  if (!match || match.isFinished) return;

  // Choisir une question GOLDEN POINT aléatoire non posée
  const goldenQuestion = getRandomQuestion(Quizz, match.questionsAsked);
  const formatted = Array.isArray(goldenQuestion.choices)
    ? goldenQuestion.choices.reduce((acc, choice, idx) => {
        const letters = ["A", "B", "C", "D"];
        acc[letters[idx]] = choice;
        return acc;
      }, {})
    : goldenQuestion.choices;

  match.questionsAsked.push({
    question: {
      text: goldenQuestion.question,
      options: formatted,
      correctOption: goldenQuestion.correctAnswer,
      isConversion: false,
      conversionPlayerId: null,
    },
    answers: [],
  });

  await match.save();

  // Calcul scores actuels (optionnel, pour afficher)
  let scoreUserOne = 0,
    scoreUserTwo = 0;
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

  // Émettre l’événement de début golden point
  io.to(matchId).emit("golden_point_started", {
    message: "Golden point triggered",
  });

  io.to(matchId).emit("golden_point_question", {
    question: {
      text: goldenQuestion.question,
      choices: formatted,
      correctAnswer: goldenQuestion.correctAnswer,
    },
    scoreUserOne,
    scoreUserTwo,
  });

  // Créer un timer 10s pour gérer fin de golden point
  const timer = setTimeout(async () => {
    const state = matchTimers.get(matchId);
    if (!state) return;

    const updatedMatch = await Match.findById(matchId);
    if (!updatedMatch) return;

    const last = updatedMatch.questionsAsked.at(-1);
    const answers = last?.answers || [];

    if (!state.handled) {
      const noAnswer = answers.length === 0;
      const allWrong = answers.every((a) => a.score === 0);

      if (noAnswer || allWrong) {
        console.log(
          "⏰ Relancer une nouvelle question GOLDEN POINT (aucune bonne réponse)"
        );

        // Marquer la question terminée
        matchTimers.set(matchId, {
          ...state,
          handled: true,
          timer: null,
          isGoldenPoint: true,
        });

        // Relancer golden point (attention boucle infinie possible, gérer max retry côté logique si souhaité)
        await launchGoldenPointQuestion(matchId);

        return;
      }
    }

    // Calcul des scores finaux après réponses
    let scoreUserOne = 0,
      scoreUserTwo = 0;

    updatedMatch.questionsAsked.forEach((q) => {
      q.answers.forEach((a) => {
        if (a.playerId.toString() === updatedMatch.creatorId._id.toString()) {
          scoreUserOne += a.score || 0;
        } else if (
          updatedMatch.joinerId &&
          a.playerId.toString() === updatedMatch.joinerId._id.toString()
        ) {
          scoreUserTwo += a.score || 0;
        }
      });
    });

    if (scoreUserOne === scoreUserTwo) {
      console.log("🔁 Égalité persistante, relance golden point");

      matchTimers.set(matchId, {
        ...state,
        handled: true,
        timer: null,
        isGoldenPoint: true,
      });

      await launchGoldenPointQuestion(matchId);
    } else {
      console.log("⏱️ Fin du match après fin du golden point");
      io.to(matchId).emit("match_finished", {
        message: "⏱️ End of the match after prolonged equality.",
      });
      io.in(matchId).socketsLeave(matchId);
      await Match.findByIdAndUpdate(matchId, { isFinished: true });
    }
  }, 10000);

  // Mettre à jour le matchTimers avec le nouveau timer et reset handled
  matchTimers.set(matchId, {
    timer,
    handled: false,
    isGoldenPoint: true,
  });

  return { scoreUserOne, scoreUserTwo };
}

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

// -------------------- Fonction helper utilitaire --------------------
const safeGetState = (matchId) => {
  return matchTimers.get(matchId) ? { ...matchTimers.get(matchId) } : {};
};

const safeSetState = (matchId, state) => {
  matchTimers.set(matchId, state);
  console.log(
    `[matchTimers] set for ${matchId}:`,
    JSON.stringify({
      handled: state.handled,
      pendingConversion: !!state.pendingConversion,
      hasTimer: !!state.timer,
      hasConversionTimeout: !!state.conversionTimeout,
      hasWaitingSecondTimeout: !!state.waitingSecondPlayerTimeout,
      isGoldenPoint: !!state.isGoldenPoint,
    })
  );
};

io.on("connection", (socket) => {
  console.log("✅ New client connected");

  socket.on("join_match_room", (matchId, callback) => {
    socket.join(matchId);
    if (callback) callback();
  });

  // -------------------- proceedToNextQuestion (remplacé) --------------------
  const proceedToNextQuestion = async (matchId, options = {}) => {
    const match = await Match.findById(matchId);
    if (!match || match.isFinished || !match.quizStarted) return;

    let state = safeGetState(matchId);

    // Protection golden point
    if (state.isGoldenPoint && !state.handled) {
      console.log(
        `[proceedToNextQuestion] golden point active, skip for ${matchId}`
      );
      return;
    }

    // half-time
    if (options.afterHalfTime && state.halfTimeNextQuestionSent) return;
    if (options.afterHalfTime) state.halfTimeNextQuestionSent = true;

    // Si il y a une conversion planifiée --> créer la question conversion (seulement ici)
    if (state.pendingConversion && !state.conversionTimeout) {
      const conv = state.pendingConversion;

      // Nettoyage préventif des timers (défensif)
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      if (state.waitingSecondPlayerTimeout) {
        clearTimeout(state.waitingSecondPlayerTimeout);
        delete state.waitingSecondPlayerTimeout;
      }

      // Crée la question conversion dans DB (uniquement ici)
      const newConvQuestion = {
        question: { ...conv.question, isConversion: true },
        answers: [],
      };
      match.questionsAsked.push(newConvQuestion);
      await match.save();

      io.to(matchId).emit("conversion_question", {
        playerId: conv.question.conversionPlayerId,
        question: {
          text: conv.question.text,
          choices: conv.question.options,
          correctAnswer: conv.question.correctOption,
        },
      });

      // Défensif : clear ancien conversionTimeout si présent
      if (state.conversionTimeout) {
        clearTimeout(state.conversionTimeout);
        delete state.conversionTimeout;
      }

      // marque as not handled (nouvelle question à répondre)
      state.handled = false;

      // crée conversionTimeout pour l'expiration
      state.conversionTimeout = setTimeout(async () => {
        let s = safeGetState(matchId);
        if (s.pendingConversion) delete s.pendingConversion;
        if (s.conversionTimeout) {
          clearTimeout(s.conversionTimeout);
          delete s.conversionTimeout;
        }
        safeSetState(matchId, s);
        console.log(
          `[proceedToNextQuestion] conversion expired for ${matchId}`
        );
        await proceedToNextQuestion(matchId);
      }, 10000);

      safeSetState(matchId, state);
      console.log(
        `[proceedToNextQuestion] conversion created for ${matchId} (questionsAsked length=${match.questionsAsked.length})`
      );
      return;
    }

    // Sinon -> nouvelle question normale
    // Nettoyage défensif : supprimer tout conversionTimeout restant si il n'y a plus de pendingConversion
    if (!state.pendingConversion && state.conversionTimeout) {
      clearTimeout(state.conversionTimeout);
      delete state.conversionTimeout;
    }

    const nextQ = getRandomQuestion(Quizz, match.questionsAsked);
    if (!nextQ) {
      match.isFinished = true;
      match.status = "finished";
      await match.save();
      io.to(matchId).emit("match_finished", { matchId });
      io.in(matchId).socketsLeave(matchId);
      matchTimers.delete(matchId);
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

    // Nettoyage des timers précédents
    if (state.timer) {
      clearTimeout(state.timer);
      delete state.timer;
    }
    if (state.waitingSecondPlayerTimeout) {
      clearTimeout(state.waitingSecondPlayerTimeout);
      delete state.waitingSecondPlayerTimeout;
    }

    match.questionsAsked.push(newQuestion);
    await match.save();

    io.to(matchId).emit("next_question", {
      question: {
        text: newQuestion.question.text,
        choices: newQuestion.question.options,
        correctAnswer: newQuestion.question.correctOption,
      },
    });

    // Timer pour forcer avance si personne ne répond
    state.timer = setTimeout(async () => {
      let s = safeGetState(matchId);
      if (!s.handled && !s.pendingConversion) {
        console.log(
          `[proceedToNextQuestion] timer expired, marking handled and advancing for ${matchId}`
        );
        markHandled(matchId);
        await proceedToNextQuestion(matchId);
      }
    }, 10000);

    state.handled = false;
    safeSetState(matchId, state);
    console.log(
      `[proceedToNextQuestion] new normal question created for ${matchId} (questionsAsked length=${match.questionsAsked.length})`
    );
  };

  socket.on("match_joined", async (data) => {
    console.log("📥 Server a reçu match_joined pour match:", data);

    const matchId = data.match._id;
    let match = await Match.findById(matchId);
    if (!match) return;
    console.log("Avant mise à jour joinerId:", match.joinerId);
    console.log("UserId reçu :", data.userId);

    if (!match.joinerId) {
      match.joinerId = data.userId;
      match.playerTwoTeam = data.teamInfo;
      await match.save();
      console.log("📝 joinerId et équipe du joueur 2 enregistrés");
    }

    if (match.playerOneTeam && match.playerTwoTeam) {
      console.log("🎮 Deux joueurs présents, démarrage du quiz");
      io.to(matchId).emit("both_players_ready_request");
      readyPlayers.set(matchId, new Set());

      if (!match.questionsAsked || match.questionsAsked.length === 0) {
        const first = getRandomQuestion(Quizz, []);
        if (!first) return;

        const formatted = Array.isArray(first.choices)
          ? first.choices.reduce((acc, choice, idx) => {
              const letters = ["A", "B", "C", "D"];
              acc[letters[idx]] = choice;
              return acc;
            }, {})
          : first.choices;

        match.questionsAsked.push({
          question: {
            text: first.question,
            options: formatted,
            correctOption: first.correctAnswer,
            isConversion: false,
            conversionPlayerId: null,
          },
          answers: [],
        });
        match.quizStarted = true;

        await match.save();
        match = await Match.findById(matchId);
      }

      const currentQuestion =
        match.questionsAsked[match.questionsAsked.length - 1];

      io.to(matchId).emit("quiz_start", { matchId });
      io.to(matchId).emit("next_question", {
        question: {
          text: currentQuestion.question.text,
          choices: currentQuestion.question.options,
          correctAnswer: currentQuestion.question.correctOption,
        },
      });

      const timer = setTimeout(() => {
        const state = matchTimers.get(matchId);
        if (!state?.handled) {
          proceedToNextQuestion(matchId);
        }
      }, 10000);

      const prev = matchTimers.get(matchId) || {};
      matchTimers.set(matchId, { ...prev, timer, handled: false });
    }
  });

  // -------------------- socket.on answer_question (remplacé) --------------------
  socket.on("answer_question", async ({ matchId, userId, selectedOption }) => {
    try {
      const match = await Match.findById(matchId)
        .populate("creatorId")
        .populate("joinerId");
      if (!match || match.isFinished) return;

      const lastQuestion = match.questionsAsked.at(-1);
      if (!lastQuestion) return;

      const isCorrect = selectedOption === lastQuestion.question.correctOption;
      const playersCount = match.joinerId ? 2 : 1;
      const playerId = userId === "AI_BOT" ? AI_BOT_USER_ID : userId;

      // Récupère état frais
      let timerState = safeGetState(matchId);
      const isGoldenPoint = timerState.isGoldenPoint === true;
      const isHandled = timerState.handled === true;

      console.log(
        `[answer_question] match=${matchId} user=${userId} sel=${selectedOption} isConv=${!!lastQuestion
          .question.isConversion} state=${JSON.stringify({
          handled: isHandled,
          pendingConversion: !!timerState.pendingConversion,
        })}`
      );

      if (isGoldenPoint && isHandled) return;

      // si déjà répondu -> ignore
      const alreadyAnswered = lastQuestion.answers.find(
        (a) => a.playerId.toString() === userId.toString()
      );
      if (alreadyAnswered) return;

      // ----- Golden point (inchangé) -----
      if (isGoldenPoint && !isHandled) {
        lastQuestion.answers.push({
          playerId,
          selectedOption,
          isCorrect,
          score: isCorrect ? 1 : 0,
          answeredAt: new Date(),
        });
        await match.save();
        if (isCorrect) {
          await updateScores(matchId);
          io.to(matchId).emit("golden_point_winner", {
            winnerId: userId,
            message: "🏆 GOLDEN POINT! The player answered correctly!",
          });
          timerState = safeGetState(matchId);
          if (timerState.timer) {
            clearTimeout(timerState.timer);
            delete timerState.timer;
          }
          timerState.handled = true;
          safeSetState(matchId, timerState);
          await Match.findByIdAndUpdate(matchId, {
            isFinished: true,
            status: "finished",
          });
        } else {
          io.to(matchId).emit("wrong_golden_point_answer", {
            playerId,
            message: "❌ Wrong answer during GOLDEN POINT",
          });
          const totalAnswersGP = lastQuestion.answers.length;
          const allIncorrect = lastQuestion.answers.every((a) => !a.isCorrect);
          if (totalAnswersGP >= playersCount && allIncorrect) {
            timerState = safeGetState(matchId);
            timerState.handled = true;
            safeSetState(matchId, timerState);
            await launchGoldenPointQuestion(matchId);
          }
        }
        return;
      }

      // ----- Normal / Conversion common logic -----
      const isConversion = lastQuestion.question.isConversion === true;
      const isConversionPlayer =
        isConversion &&
        lastQuestion.question.conversionPlayerId?.toString() ===
          userId.toString();

      // Si NON conversion ou conversion mais pas le joueur de conversion => push ici
      if (!isConversion || (isConversion && !isConversionPlayer)) {
        const scoreToAdd = isCorrect ? (isConversion ? 2 : 4) : 0;
        lastQuestion.answers.push({
          playerId,
          selectedOption,
          isCorrect,
          score: scoreToAdd,
          answeredAt: new Date(),
        });
        await match.save();
      }

      // Recompute totalAnswers
      const totalAnswers = lastQuestion.answers.length;

      io.to(matchId).emit("answer_question", {
        matchId,
        playerId,
        questionText: lastQuestion.question.text,
        selectedOption,
        isCorrect,
        answeredAt: new Date(),
      });

      // ----- Si c'est le joueur de conversion qui répond -----
      if (isConversion && isConversionPlayer) {
        console.log(
          `[answer_question] conversion answer by ${userId} on match ${matchId}`
        );

        // push sa réponse (une seule fois ici)
        lastQuestion.answers.push({
          playerId,
          selectedOption,
          isCorrect,
          score: isCorrect ? 2 : 0,
          answeredAt: new Date(),
        });
        await match.save();

        // utilise DB pour remettre à jour scores (single source)
        await updateScores(matchId);

        // Nettoyage défensif de tous timers qui pourraient bloquer
        const currentState = safeGetState(matchId);
        if (currentState.conversionTimeout) {
          clearTimeout(currentState.conversionTimeout);
          delete currentState.conversionTimeout;
        }
        if (currentState.waitingSecondPlayerTimeout) {
          clearTimeout(currentState.waitingSecondPlayerTimeout);
          delete currentState.waitingSecondPlayerTimeout;
        }
        if (currentState.timer) {
          clearTimeout(currentState.timer);
          delete currentState.timer;
        }

        delete currentState.pendingConversion;
        // Leave handled = false to allow next flow — but set explicit false to be safe
        currentState.handled = false;
        safeSetState(matchId, currentState);

        console.log(
          `[answer_question] conversion processed for match ${matchId} -> cleaned timers & state`
        );

        // proceed next
        setTimeout(() => proceedToNextQuestion(matchId), 700);
        return;
      }

      // ----- Réponses normales -----
      await updateScores(matchId);

      // Si correct et non conversion => schedule pendingConversion
      if (isCorrect && !isConversion) {
        io.to(matchId).emit("correct_answer_received", {
          playerId,
          message: `Try ${
            userId.toString() === match.creatorId._id.toString()
              ? match.playerOneTeam.title
              : match.playerTwoTeam?.title || "Team"
          } !`,
        });

        setTimeout(() => {
          const convQ =
            Quizz.find((q) => q.isConversion) ||
            Quizz[Math.floor(Math.random() * Quizz.length)];
          const formattedConvOptions = Array.isArray(convQ.choices)
            ? convQ.choices.reduce((acc, choice, idx) => {
                acc[["A", "B", "C", "D"][idx]] = choice;
                return acc;
              }, {})
            : convQ.choices;

          const cs = safeGetState(matchId);
          cs.pendingConversion = {
            question: {
              text: convQ.question,
              options: formattedConvOptions,
              correctOption: convQ.correctAnswer,
              isConversion: true,
              conversionPlayerId: userId,
            },
            answers: [],
          };
          if (cs.conversionTimeout) {
            clearTimeout(cs.conversionTimeout);
            delete cs.conversionTimeout;
          }
          cs.handled = false;
          safeSetState(matchId, cs);

          // ⚡⚡ CORRECTIF : on force immédiatement proceedToNextQuestion
          proceedToNextQuestion(matchId);
        }, 1000);

        return;
      }

      // Waiting for second player or proceed
      if (totalAnswers < playersCount && playersCount === 2) {
        const cs = safeGetState(matchId);
        if (!cs.waitingSecondPlayerTimeout) {
          const timeout = setTimeout(() => {
            proceedToNextQuestion(matchId);
            const s = safeGetState(matchId);
            delete s.waitingSecondPlayerTimeout;
            safeSetState(matchId, s);
          }, 10000);
          cs.waitingSecondPlayerTimeout = timeout;
          safeSetState(matchId, cs);
        }
      } else {
        proceedToNextQuestion(matchId);
      }
    } catch (error) {
      console.error("❌ Erreur socket answer_question:", error);
    }
  });

  socket.on("half_time_triggered", async ({ matchId }) => {
    const match = await Match.findById(matchId);
    if (!match || match.halfTimeTriggered) return;

    match.halfTimeTriggered = true;
    await match.save();

    const timerState = matchTimers.get(matchId) || {};

    // Nettoyer tous les timers actifs
    if (timerState.timer) clearTimeout(timerState.timer);
    if (timerState.conversionTimeout)
      clearTimeout(timerState.conversionTimeout);
    if (timerState.waitingSecondPlayerTimeout)
      clearTimeout(timerState.waitingSecondPlayerTimeout);

    matchTimers.set(matchId, {
      ...timerState,
      halfTimeNextQuestionSent: false,
      conversionTimeout: null,
      waitingSecondPlayerTimeout: null,
      pendingConversion: null,
      handled: false,
    });

    io.to(matchId).emit("half_time", { message: "⏸️ HALF-TIME! Quick break!" });

    setTimeout(() => {
      proceedToNextQuestion(matchId, { afterHalfTime: true });
    }, 5000);
  });

  socket.on("quiz_start", async ({ matchId }) => {
    let match = await Match.findById(matchId);
    if (!match) return;

    if (!match.questionsAsked || match.questionsAsked.length === 0) {
      const first = Quizz[0];
      if (!first) return;

      const formatted = Array.isArray(first.choices)
        ? first.choices.reduce((acc, choice, idx) => {
            const letters = ["A", "B", "C", "D"];
            acc[letters[idx]] = choice;
            return acc;
          }, {})
        : first.choices;

      match.questionsAsked.push({
        question: {
          text: first.question,
          options: formatted,
          correctOption: first.correctAnswer,
          isConversion: false,
          conversionPlayerId: null,
        },
        answers: [],
      });

      await match.save();
    }

    match = await Match.findById(matchId);
    const firstQuestion = match.questionsAsked[0];
    if (!firstQuestion) return;

    io.to(matchId).emit("next_question", {
      question: {
        text: firstQuestion.question.text,
        choices: firstQuestion.question.options,
        correctAnswer: firstQuestion.question.correctOption,
      },
    });

    const timer = setTimeout(() => {
      const state = matchTimers.get(matchId);
      if (!state?.handled) {
        matchTimers.set(matchId, {
          ...state,
          handled: true,
        });
        markHandled(matchId);
        proceedToNextQuestion(matchId);
      }
    }, 10000);

    const prev = matchTimers.get(matchId) || {};
    matchTimers.set(matchId, { ...prev, timer, handled: false });
  });

  socket.on("request_current_question", async ({ matchId }) => {
    const match = await Match.findById(matchId);
    if (!match || !match.questionsAsked || match.questionsAsked.length === 0)
      return;

    const currentQuestion =
      match.questionsAsked[match.questionsAsked.length - 1];

    io.to(matchId).emit("next_question", {
      question: {
        text: currentQuestion.question.text,
        choices: currentQuestion.question.options,
        correctAnswer: currentQuestion.question.correctOption,
      },
    });

    // Si le match est contre IA → IA répond automatiquement
    if (match.isAgainstAI) {
      simulateAIAnswer(io, match, match.questionsAsked.length - 1);
    }
  });

  socket.on("player_leave_match", async ({ matchId, userId }) => {
    try {
      const match = await Match.findById(matchId);

      if (!match || match.isFinished) {
        return socket.emit("error", {
          message: "Match not found or already finished.",
        });
      }

      // ✅ Marquer le match comme terminé
      match.isFinished = true;
      match.status = "finished";
      match.leaverId = userId;

      await match.save();

      // ✅ Nettoyer les timers
      const timerState = matchTimers.get(matchId);
      if (timerState?.timer) {
        clearTimeout(timerState.timer);
        matchTimers.delete(matchId);
      }

      // ✅ Notifier tous les joueurs que le match est terminé à cause du départ
      io.to(matchId.toString()).emit("match_finished_due_to_leave", {
        matchId,
        leaverId: userId,
      });
      io.in(matchId).socketsLeave(matchId);
    } catch (error) {
      console.error("❌ Erreur dans player_leave_match :", error);
      socket.emit("error", {
        message: "Error abandoning the match.",
      });
    }
  });

  // ✅ GOLDEN POINT event
  socket.on("golden_point_trigger", async ({ matchId, force = false }) => {
    try {
      const existingTimer = matchTimers.get(matchId);

      // Modifier la condition pour ignorer le trigger uniquement si pas de force
      if (existingTimer?.isGoldenPoint && !existingTimer.handled && !force) {
        console.log(
          `[golden_point_trigger] Question ongoing, ignoring trigger`
        );
        return;
      }

      // Plus de limite retryCount supprimée

      // Lancer la question golden point (fonctions à adapter selon ton code)
      await launchGoldenPointQuestion(matchId);

      // Nettoyer ancien timer
      if (existingTimer?.timer) clearTimeout(existingTimer.timer);

      // Créer timer 10s pour attendre réponses
      const timer = setTimeout(async () => {
        const state = matchTimers.get(matchId);
        if (!state) return;

        const updatedMatch = await Match.findById(matchId);
        if (!updatedMatch) return;

        const last = updatedMatch.questionsAsked.at(-1);
        const answers = last?.answers || [];

        if (!state.handled) {
          const noAnswer = answers.length === 0;
          const allWrong = answers.every((a) => a.score === 0);

          if (noAnswer || allWrong) {
            console.log(
              "⏰ Relancer une nouvelle question GOLDEN POINT (aucune bonne réponse)"
            );

            // Marquer la question traitée (handled = true)
            matchTimers.set(matchId, {
              ...state,
              handled: true,
              timer: null,
              isGoldenPoint: true,
            });

            // Relancer directement la question golden point (pas via émission socket)
            await launchGoldenPointQuestion(matchId);

            // Reset handled = false et timer dans matchTimers pour la nouvelle question
            matchTimers.set(matchId, {
              timer,
              handled: false,
              isGoldenPoint: true,
            });

            return;
          }
        }

        // Calcul scores après timeout
        let scoreUserOne = 0,
          scoreUserTwo = 0;

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

        if (scoreUserOne === scoreUserTwo) {
          console.log("🔁 Égalité persistante, relance golden point");

          matchTimers.set(matchId, {
            ...state,
            handled: true,
            timer: null,
            isGoldenPoint: true,
          });

          // Relance directe
          await launchGoldenPointQuestion(matchId);

          matchTimers.set(matchId, {
            timer,
            handled: false,
            isGoldenPoint: true,
          });
        } else {
          console.log("⏱️ Fin du match après fin du golden point");
          io.to(matchId).emit("match_finished", {
            message: "⏱️ End of the match after prolonged equality.",
          });
          io.in(matchId).socketsLeave(matchId);
          await Match.findByIdAndUpdate(matchId, { isFinished: true });
        }
      }, 10000);

      // Mettre à jour timer et reset handled à false car nouvelle question lancée
      matchTimers.set(matchId, {
        timer,
        handled: false,
        isGoldenPoint: true,
      });
    } catch (e) {
      console.error("❌ Erreur dans golden_point_trigger:", e);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
  });
});

// Start the server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
