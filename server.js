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
// 🔗 Rendre io accessible dans les controllers
app.set("io", io);

const getRandomQuestion = (quizzList, alreadyAsked) => {
  const notAsked = quizzList.filter(
    (q) => !alreadyAsked.some((asked) => asked.question.text === q.question)
  );
  if (notAsked.length === 0) return null;
  const index = Math.floor(Math.random() * notAsked.length);
  return notAsked[index];
};

io.on("connection", (socket) => {
  console.log("✅ New client connected");

  socket.on("join_match_room", (matchId, callback) => {
    socket.join(matchId);
    if (callback) callback(); // très important
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
    if (!match || match.isFinished) return;

    if (!match.quizStarted) {
      console.log("🚫 Quiz pas encore démarré. Ignorer le timer.");
      return;
    }
    if (match.isFinished) {
      console.log("⛔️ Match terminé, pas de nouvelle question envoyée.");
      return;
    }
    // 🔄 Vérifie si une conversion était en attente
    let justInjectedConversion = false;

    const timerState = matchTimers.get(matchId);
    if (timerState?.pendingConversion) {
      const convQuestion = timerState.pendingConversion;

      convQuestion.question.text = convQuestion.question.text || "MISSING_TEXT";
      convQuestion.question.options = convQuestion.question.options || {};
      convQuestion.question.correctOption =
        convQuestion.question.correctOption || null;
      convQuestion.question.isConversion = true;

      match.questionsAsked.push(convQuestion);
      console.log(
        "✅ Question de conversion enregistrée :",
        convQuestion.question
      );

      await match.save();
      justInjectedConversion = true;

      if (timerState.timer) clearTimeout(timerState.timer);
      matchTimers.set(matchId, {
        ...timerState,
        handled: true,
        pendingConversion: null,
      });
    }

    // 🎯 Nouvelle question
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

    // 🔍 Analyse dernière question (pas de conversion enchaînée)
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
      console.log(
        "🧠 firstCorrectPlayer dans matchTimers:",
        state?.firstCorrectPlayer
      );

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
          matchTimers.delete(matchId);
          proceedToNextQuestion(matchId);
        }
      }, 10000);

      const current = matchTimers.get(matchId);
      if (!current?.handled) {
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
      }

      return;
    }

    // Question normale
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
        matchTimers.delete(matchId);
        proceedToNextQuestion(matchId);
      }
    }, 10000);

    matchTimers.set(matchId, { timer, handled: false });
    match.questionsAsked.forEach((q, i) => {
      console.log(
        `- Q${i + 1}: ${q.question.text} | isConversion: ${
          q.question.isConversion
        }`
      );
    });
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
          matchTimers.delete(matchId);
          // proceedToNextQuestion(matchId);
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
      const conversionPlayerId = lastQuestion.question.conversionPlayerId;
      const isConversionPlayer =
        isConversion && conversionPlayerId?.toString() === userId.toString();

      const scoreToAdd = isCorrect ? (isConversionPlayer ? 2 : 4) : 0;

      // Ajout de la réponse
      lastQuestion.answers.push({
        playerId: userId,
        selectedOption,
        isCorrect,
        score: scoreToAdd,
        answeredAt: new Date(),
      });

      await match.save();

      // ⚡ Notifie tous les clients qu’un joueur a répondu
      io.to(matchId).emit("answer_question", {
        matchId,
        playerId: userId,
        questionText: lastQuestion.question.text,
        selectedOption,
        isCorrect,
        answeredAt: new Date(),
      });

      // 🎯 Résultat de la conversion
      if (isConversion && isConversionPlayer) {
        console.log(
          "🎯 Réponse à une question de conversion reçue, résultat:",
          isCorrect
        );

        io.to(matchId).emit("conversion_result", {
          playerId: userId,
          success: isCorrect,
          message: isCorrect
            ? "CONVERSION SUCCESSFUL"
            : "CONVERSION UNSUCCESSFUL",
        });
      }

      // ✅ Fix ici
      const current = matchTimers.get(matchId);
      if (current) {
        matchTimers.set(matchId, { ...current, handled: false });
      }
      // Passer à la question suivante après un petit délai
      setTimeout(() => {
        console.log("⏭️ Passage à la question suivante après conversion");

        proceedToNextQuestion(matchId);
      }, 1500);
      // 🧮 Calcul des scores
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

      // 🔁 Conversion trigger
      if (!match.hasConversionStarted && !match.conversionBy) {
        let teamToConvert = null;

        if (scoreUserOne === 4) {
          teamToConvert = "playerOne";
        } else if (scoreUserTwo === 4) {
          teamToConvert = "playerTwo";
        }

        if (teamToConvert) {
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

          match.hasConversionStarted = true;
          match.conversionBy = teamToConvert;

          match.questionsAsked.push({
            question: {
              text: convQ.question,
              options: formattedConvOptions,
              correctOption: convQ.correctAnswer,
              isConversion: true,
              conversionPlayerId:
                teamToConvert === "playerOne"
                  ? match.creatorId._id
                  : match.joinerId._id,
            },
            answers: [],
          });

          await match.save();

          io.to(matchId).emit("conversion_question", {
            playerId:
              teamToConvert === "playerOne"
                ? match.creatorId._id
                : match.joinerId._id,
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

      // ⏭️ Passage à la prochaine question si 2 réponses
      if (lastQuestion.answers.length >= 2) {
        const nextIndex = match.questionsAsked.length;

        if (nextIndex < Quizz.length) {
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
            message: "Le quiz est terminé ! Merci d’avoir joué.",
          });
        }
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
        matchTimers.delete(matchId);
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

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
  });
});

server.listen(1234, () => {
  console.log("🚀 Server is running on port 1234");
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  // Lancer le nettoyeur de matchs en attente
  // startMatchCleaner();
});
