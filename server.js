const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const socketIo = require("socket.io");
const http = require("http");

const dotenv = require("dotenv");
const authRoutes = require("./routers/authRoutes");
const matchRoutes = require("./routers/matchRoutes");
const Match = require("./models/Match");
const Quizz = require("./models/Quizz");
const { log } = require("console");

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
const server = http.createServer(app);
const matchTimers = new Map();

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

const getRandomQuestion = (quizzList, alreadyAsked) => {
  const notAsked = quizzList.filter(
    (q) => !alreadyAsked.some((asked) => asked.question.text === q.question)
  );
  if (notAsked.length === 0) return null;
  const index = Math.floor(Math.random() * notAsked.length);
  return notAsked[index];
};

function sendNextQuestion(match, matchId, nextIndex) {
  const totalQuestions = Quizz.length;

  if (nextIndex >= totalQuestions) {
    match.isFinished = true;
    match.save().then(() => {
      io.to(matchId).emit("match_finished", {
        message: "Le quiz est terminé ! Merci d’avoir joué.",
      });
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

  match.questionsAsked.push({
    question: {
      text: nextQ.question,
      options: formattedOptions,
      correctOption: nextQ.correctAnswer,
      isConversion: nextQ.isConversion || false,
    },
    answers: [],
  });

  match.save().then(() => {
    io.to(matchId).emit("next_question", {
      question: {
        text: nextQ.question,
        choices: formattedOptions,
        correctAnswer: nextQ.correctAnswer,
      },
    });
  });
}

io.on("connection", (socket) => {
  console.log("✅ New client connected");

  const markHandled = (matchId) => {
    const current = matchTimers.get(matchId);
    if (current) {
      console.log(`🔒 handled=true pour matchId=${matchId}`);
      matchTimers.set(matchId, {
        ...current,
        handled: true,
      });
    }
  };

  socket.on("join_match_room", (matchId, callback) => {
    socket.join(matchId);
    if (callback) callback();
  });

  const proceedToNextQuestion = async (matchId) => {
    console.log(`⏩ proceedToNextQuestion appelé pour matchId=${matchId}`);

    const currentState = matchTimers.get(matchId);
    if (currentState?.handled) {
      console.log(
        "⏭️ Question déjà gérée, on ne relance pas proceedToNextQuestion"
      );
      return;
    }

    const match = await Match.findById(matchId);
    if (!match || match.isFinished || match.leaverId || !match.quizStarted)
      return;

    let justInjectedConversion = false;
    const timerState = matchTimers.get(matchId);

    // 👉 Conversion en attente ?
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
      // 👉 On continue vers la question suivante juste après
    }

    // 👉 Question normale suivante
    const next = getRandomQuestion(Quizz, match.questionsAsked);
    if (!next) {
      match.isFinished = true;
      await match.save();
      io.to(matchId).emit("match_finished", { matchId });
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

      if (matchTimers.has(matchId)) {
        const old = matchTimers.get(matchId);
        if (old?.timer) clearTimeout(old.timer);
      }

      const timer = setTimeout(async () => {
        const refreshedMatch = await Match.findById(matchId);
        if (refreshedMatch?.isFinished) return;
        const state = matchTimers.get(matchId);
        if (!state?.handled) {
          console.log(
            "⏱️ Timeout conversion : aucune réponse → passer à la question suivante"
          );
          markHandled(matchId);
          proceedToNextQuestion(matchId);
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

      return; // ⛔ On attend la conversion avant d'envoyer une autre question normale
    }

    // ✅ Question normale
    match.questionsAsked.push(newQuestion);
    await match.save();

    io.to(matchId).emit("next_question", {
      question: {
        text: next.question,
        choices: formatted,
        correctAnswer: next.correctAnswer,
      },
    });

    if (matchTimers.has(matchId)) {
      const prev = matchTimers.get(matchId);
      if (prev?.timer) clearTimeout(prev.timer);
    }

    const timer = setTimeout(() => {
      const state = matchTimers.get(matchId);
      if (!state?.handled) {
        console.log(
          "⏱️ Timeout question normale : aucune réponse → passer à la suivante"
        );
        markHandled(matchId);
        proceedToNextQuestion(matchId);
      }
    }, 10000);

    matchTimers.set(matchId, { timer, handled: false });
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

      matchTimers.set(matchId, { timer, handled: false });
    }
  });

  socket.on("answer_question", async ({ matchId, userId, selectedOption }) => {
    try {
      const match = await Match.findById(matchId)
        .populate("creatorId")
        .populate("joinerId");

      if (!match || match.isFinished) return;

      const lastQuestion = match.questionsAsked.at(-1);
      if (!lastQuestion) return;

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

      // Marquer la question comme "handled" pour éviter que le timer relance
      const currentTimerState = matchTimers.get(matchId);
      if (currentTimerState && !currentTimerState.handled) {
        matchTimers.set(matchId, {
          ...currentTimerState,
          handled: true,
        });
        console.log(
          `🔒 Question marquée comme handled pour matchId=${matchId} car réponse reçue`
        );
      }
      io.to(matchId).emit("answer_question", {
        matchId,
        playerId: userId,
        questionText: lastQuestion.question.text,
        selectedOption,
        isCorrect,
        answeredAt: new Date(),
      });

      // 🧮 Calcul et MAJ des scores EN TEMPS RÉEL
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

      // ✅ Si c'était une conversion : afficher résultat + passer à la suite
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
              message: "Le quiz est terminé ! Merci d’avoir joué.",
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

        return; // important
      }

      // ✅ Notifier uniquement les bonnes réponses (hors conversion)
      if (isCorrect && !isConversion) {
        // Etape 0 :  détecter le team name
        const teamTitle =
          userId.toString() === match.creatorId.toString()
            ? match.playerOneTeam.title
            : match.playerTwoTeam?.title || "Team";

        // ✅ Étape 1 : notifier la bonne réponse
        io.to(matchId).emit("correct_answer_received", {
          playerId: userId,
          message: `Try ${teamTitle} !`,
        });

        // ✅ Étape 2 : attendre 2 secondes AVANT d'envoyer la conversion
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
        }, 500); // ⏱️ délai de 2 secondes

        return;
      }

      // ✅ Si tous les joueurs ont répondu → passer à la prochaine question
      const totalAnswers = lastQuestion.answers.length;
      const playersCount = match.joinerId ? 2 : 1;

      if (totalAnswers >= playersCount) {
        setTimeout(async () => {
          const updatedMatch = await Match.findById(matchId);
          const nextIndex = updatedMatch.questionsAsked.length;
          const totalQuestions = Quizz.length;

          // ✅ Si on est à la moitié et pas encore déclenché
          const isHalfTime =
            !updatedMatch.halfTimeTriggered &&
            nextIndex >= Math.floor(totalQuestions / 2);

          if (isHalfTime) {
            updatedMatch.halfTimeTriggered = true;
            await updatedMatch.save();

            // 🔥 Diffuse "HALF-TIME" aux joueurs
            io.to(matchId).emit("half_time", {
              message: "⏸️ HALF-TIME! Quick break!",
            });

            // ⏱️ Pause de 5 secondes avant de continuer
            setTimeout(() => {
              sendNextQuestion(updatedMatch, matchId, nextIndex);
            }, 5000);
          } else {
            sendNextQuestion(updatedMatch, matchId, nextIndex);
          }
        }, 3000);
      }
    } catch (error) {
      console.error("❌ Erreur socket answer_question:", error);
    }
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
        proceedToNextQuestion(matchId);
      }
    }, 10000);

    matchTimers.set(matchId, { timer, handled: false });
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
  });

  socket.on("player_leave_match", async ({ matchId, userId }) => {
    try {
      const match = await Match.findById(matchId);

      if (!match || match.isFinished) {
        return socket.emit("error", {
          message: "Match introuvable ou déjà terminé.",
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

      console.log(`🚪 Joueur ${userId} a quitté le match ${matchId}`);
    } catch (error) {
      console.error("❌ Erreur dans player_leave_match :", error);
      socket.emit("error", {
        message: "Erreur lors de l'abandon du match.",
      });
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
