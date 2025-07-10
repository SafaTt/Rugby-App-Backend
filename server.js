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
    const currentState = matchTimers.get(matchId);
    if (currentState?.handled) {
      console.log(
        "⏭️ Question déjà gérée, on ne relance pas proceedToNextQuestion"
      );
      return;
    }
    const match = await Match.findById(matchId);
    if (!match || match.isFinished) return;

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

      await match.save();
      justInjectedConversion = true;

      if (timerState.timer) clearTimeout(timerState.timer);
      matchTimers.set(matchId, { handled: true });
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

    if (previousQuestion && !justInjectedConversion) {
      const correctAnswers = previousQuestion.answers.filter(
        (a) => a.selectedOption === previousQuestion.question.correctOption
      );

      if (
        correctAnswers.length === 1 &&
        !previousQuestion.question.isConversion
      ) {
        launchConversion = true;
        playerIdToConvert = correctAnswers[0].playerId;
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
  };

  socket.on("match_joined", async (data) => {
    console.log("📥 Server a reçu match_joined pour match:", data.match);

    const matchId = data.match._id;
    let match = await Match.findById(matchId);
    if (!match) return;

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
          proceedToNextQuestion(matchId);
        }
      }, 10000);

      matchTimers.set(matchId, { timer, handled: false });
    }
  });

  socket.on("answer_question", async ({ matchId, userId, selectedOption }) => {
    const match = await Match.findById(matchId);

    if (!match || match.isFinished) return;

    const lastQuestion = match.questionsAsked.at(-1);
    const alreadyAnswered = lastQuestion.answers.find(
      (a) => a.userId == userId
    );
    if (alreadyAnswered) return;

    const isCorrect = selectedOption === lastQuestion.question.correctOption;
    const isConversion = lastQuestion.question.isConversion === true;
    const isConversionPlayer =
      isConversion &&
      lastQuestion.question.conversionPlayerId?.toString() ===
        userId.toString();

    const scoreToAdd = isCorrect ? (isConversionPlayer ? 2 : 4) : 0;

    lastQuestion.answers.push({
      playerId: userId,
      selectedOption,
      score: scoreToAdd,
    });

    await match.save();

    // ✅ Calcul score en temps réel
    let scoreUserOne = 0;
    let scoreUserTwo = 0;
    const creatorId = match.creatorId.toString();
    const joinerId = match.joinerId?.toString();

    match.questionsAsked.forEach((q) => {
      q.answers.forEach((a) => {
        const playerId = a.playerId.toString();
        if (playerId === creatorId) scoreUserOne += a.score || 0;
        else if (joinerId && playerId === joinerId)
          scoreUserTwo += a.score || 0;
      });
    });

    // ✅ Émission du score mise à jour
    io.to(matchId).emit("score_updated", {
      matchId,
      scoreUserOne,
      scoreUserTwo,
    });

    // ✅ Résultat de conversion
    const prevQuestion = match.questionsAsked.at(-2);
    const isConversionPhase =
      prevQuestion &&
      prevQuestion.question.isConversion &&
      prevQuestion.answers.length === 1;

    if (isConversionPhase) {
      io.to(matchId).emit("conversion_result", {
        playerId: userId,
        success: isCorrect,
      });

      io.to(matchId).emit("score_updated", {
        matchId,
        scoreUserOne,
        scoreUserTwo,
      });

      console.log("📤 Emission score_updated (conversion)");
    }

    // ✅ Aller à la prochaine question
    const state = matchTimers.get(matchId);
    if (isCorrect && state?.handled === false) {
      clearTimeout(state.timer);
      matchTimers.set(matchId, { timer: null, handled: true });
      proceedToNextQuestion(matchId);
      return;
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
