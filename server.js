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

io.on("connection", (socket) => {
  console.log("✅ New client connected");

  socket.on("join_match_room", (matchId) => {
    socket.join(matchId);
    console.log(`Socket ${socket.id} joined room ${matchId}`);
  });

  socket.on("match_joined", async (data) => {
    const matchId = data.match._id;
    let match = await Match.findById(matchId);
    if (!match) return;

    if (match.playerOneTeam && match.playerTwoTeam) {
      console.log("🎮 Deux joueurs présents, démarrage du quiz");

      // ⚡️ Démarre immédiatement le quiz ici
      if (!match.questionsAsked || match.questionsAsked.length === 0) {
        const first = Quizz[0];
        if (!first) return;

        const formattedOptions = Array.isArray(first.choices)
          ? first.choices.reduce((acc, choice, idx) => {
              const letters = ["A", "B", "C", "D"];
              acc[letters[idx]] = choice;
              return acc;
            }, {})
          : first.choices;

        match.questionsAsked.push({
          question: {
            text: first.question,
            options: formattedOptions,
            correctOption: first.correctAnswer,
          },
          answers: [],
        });

        await match.save();
        match = await Match.findById(matchId);
      }

      const firstQuestion = match.questionsAsked[0];
      if (!firstQuestion) return;

      io.to(matchId).emit("quiz_start", { matchId });
      io.to(matchId).emit("next_question", {
        question: {
          text: firstQuestion.question.text,
          choices: firstQuestion.question.options,
          correctAnswer: firstQuestion.question.correctOption,
        },
      });
    }
  });

  // Quand serveur reçoit 'quiz_start', il envoie la 1ère question
  socket.on("quiz_start", async ({ matchId }) => {
    let match = await Match.findById(matchId);
    if (!match) return;

    if (!match.questionsAsked || match.questionsAsked.length === 0) {
      const first = Quizz[0];
      if (!first) return;

      const formattedOptions = Array.isArray(first.choices)
        ? first.choices.reduce((acc, choice, idx) => {
            const letters = ["A", "B", "C", "D"];
            acc[letters[idx]] = choice;
            return acc;
          }, {})
        : first.choices;

      match.questionsAsked.push({
        question: {
          text: first.question,
          options: formattedOptions,
          correctOption: first.correctAnswer,
        },
        answers: [],
      });

      await match.save();
    }

    // Récupère la 1ère question dans la DB
    match = await Match.findById(matchId);
    const firstQuestion = match.questionsAsked[0];
    if (!firstQuestion) return;

    // N'EMETS PAS 'quiz_start' ici à nouveau (sinon boucle)

    // Envoie la question aux joueurs dans la room
    io.to(matchId).emit("next_question", {
      question: {
        text: firstQuestion.question.text,
        choices: firstQuestion.question.options,
        correctAnswer: firstQuestion.question.correctOption,
      },
    });
  });

  socket.on("request_current_question", async ({ matchId }) => {
    console.log("📥 request_current_question reçu pour matchId:", matchId);
    const match = await Match.findById(matchId);
    if (!match || !match.questionsAsked || match.questionsAsked.length === 0)
      return;

    const currentQuestion =
      match.questionsAsked[match.questionsAsked.length - 1];

    // ✅ CHANGER CECI
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
