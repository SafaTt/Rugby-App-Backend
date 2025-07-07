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

  socket.on("join_match_room", (matchId) => {
    socket.join(matchId);
    console.log(`Socket ${socket.id} joined room ${matchId}`);
  });

  const proceedToNextQuestion = async (matchId) => {
    const match = await Match.findById(matchId);
    if (!match || match.isFinished) return;

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

    match.questionsAsked.push({
      question: {
        text: next.question,
        options: formatted,
        correctOption: next.correctAnswer,
      },
      answers: [],
    });

    await match.save();

    io.to(matchId).emit("next_question", {
      question: {
        text: next.question,
        choices: formatted,
        correctAnswer: next.correctAnswer,
      },
    });

    // Nouveau timer de 10s pour la prochaine question
    if (matchTimers.has(matchId)) {
      clearTimeout(matchTimers.get(matchId).timer);
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
    const matchId = data.match._id;
    let match = await Match.findById(matchId);
    if (!match) return;

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

      // Timer 10s pour la première question
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

    const lastQuestion = match.questionsAsked[match.questionsAsked.length - 1];
    const alreadyAnswered = lastQuestion.answers.find(
      (a) => a.userId === userId
    );
    if (alreadyAnswered) return;

    lastQuestion.answers.push({ userId, selectedOption });
    await match.save();

    const state = matchTimers.get(matchId);
    if (state && !state.handled) {
      clearTimeout(state.timer);
      matchTimers.set(matchId, { timer: null, handled: true });
      proceedToNextQuestion(matchId);
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

    // Timer aussi pour quiz_start (en cas de lancement via admin)
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
