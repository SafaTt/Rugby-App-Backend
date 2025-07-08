const Match = require("../models/Match");
const Quizz = require("../models/Quizz");

const createMatch = async (req, res) => {
  try {
    const { competition, duration, playerOneTeam } = req.body;
    const creatorId = req.user._id;

    if (!competition || !duration || !playerOneTeam) {
      return res.status(400).json({ message: "Missing match data" });
    }

    const newMatch = new Match({
      competition,
      duration,
      playerOneTeam,
      creatorId,
      questionsAsked: [], // explicitement vide au départ
    });

    const savedMatch = await newMatch.save();

    const io = req.app.get("io");
    if (io) {
      io.emit("new_match_created", { match: savedMatch });
    }

    res.status(201).json(savedMatch);
  } catch (error) {
    console.error("❌ Error in createMatch:", error);

    res.status(500).json({
      message: "Erreur lors de la création du match",
      error: error.message || error,
    });
  }
};

const joinMatch = async (req, res) => {
  try {
    const matchId = req.params.id;
    const { playerTwoTeam } = req.body;
    const joinerId = req.user._id;

    const match = await Match.findById(matchId);

    if (!match) return res.status(404).json({ message: "Match not found" });
    if (match.joinerId)
      return res.status(400).json({ message: "This match is already full" });

    if (
      match.playerOneTeam &&
      match.playerOneTeam.title.toLowerCase() ===
        playerTwoTeam.title.toLowerCase()
    ) {
      return res
        .status(400)
        .json({ message: "You cannot select the same team as Player One." });
    }

    match.playerTwoTeam = playerTwoTeam;
    match.joinerId = joinerId;
    match.status = "in-progress";
    match.startTime = new Date();

    const updatedMatch = await match.save();

    const io = req.app.get("io");
    if (io) {
      // Notifier que le joueur 2 a rejoint
      io.emit("match_joined", {
        matchId: updatedMatch._id,
        match: updatedMatch,
      });
    }

    res.status(200).json(updatedMatch);
  } catch (error) {
    console.error("Join Match Error:", error);
    res.status(500).json({
      message: "Error while joining the match",
      error: error.message || error,
    });
  }
};

// Obtenir un match par ID
const getMatchById = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id)
      .populate("creatorId")
      .populate("joinerId");
    if (!match) return res.status(404).json({ message: "Match non trouvé" });

    res.status(200).json(match);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Erreur lors de la récupération du match", error });
  }
};

// Lister les matchs disponibles (en attente d’un joueur 2)
const getWaitingMatches = async (req, res) => {
  try {
    const matches = await Match.find({ status: "waiting" }).populate(
      "creatorId"
    );
    res.status(200).json(matches);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Erreur lors de la récupération des matchs", error });
  }
};

// Mettre à jour le statut d’un match (optionnel)
const updateMatchStatus = async (req, res) => {
  try {
    const match = await Match.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );

    if (!match) return res.status(404).json({ message: "Match non trouvé" });

    res.status(200).json(match);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Erreur lors de la mise à jour du statut", error });
  }
};

const findFirstPendingMatch = async (req, res) => {
  try {
    const { competition, duration } = req.body;

    // Recherche d’un match en attente avec les mêmes critères
    const pendingMatch = await Match.findOne({
      status: "waiting",
      competition,
      duration,
    }).sort({ createdAt: 1 });

    if (!pendingMatch) {
      return res.status(404).json({
        message: "Aucun match en attente trouvé avec ces critères",
      });
    }

    res.status(200).json(pendingMatch);
  } catch (error) {
    res.status(500).json({
      message: "Erreur lors de la recherche du match",
      error,
    });
  }
};

const cancelOldPendingMatches = async () => {
  const oneMinuteAgo = new Date(Date.now() - 50 * 1000);

  const result = await Match.updateMany(
    { status: "waiting", createdAt: { $lt: oneMinuteAgo } },
    { status: "cancelled" }
  );

  console.log(`${result.modifiedCount} old matches cancelled`);
};

// Ajouter une nouvelle question avec ses réponses à un match existant
// with kick at goal
const updateMatchWithQuestion = async (req, res) => {
  try {
    const matchId = req.params.id;
    const userId = req.user._id;
    const { question, selectedOption } = req.body;

    if (
      !question ||
      !question.text ||
      !question.options ||
      !question.correctOption
    ) {
      return res
        .status(400)
        .json({ message: "Données de question incomplètes" });
    }

    const isCorrect = selectedOption === question.correctOption;
    const answeredAt = new Date();

    let match = await Match.findOne({
      _id: matchId,
      "questionsAsked.question.text": question.text,
    });

    if (!match) {
      match = await Match.findByIdAndUpdate(
        matchId,
        {
          $push: {
            questionsAsked: {
              question: {
                text: question.text,
                options: question.options,
                correctOption: question.correctOption,
              },
              answers: [
                {
                  playerId: userId,
                  selectedOption,
                  isCorrect,
                  answeredAt,
                  score: isCorrect ? 4 : 0,
                },
              ],
            },
          },
        },
        { new: true }
      );
      return res
        .status(200)
        .json({ message: "Réponse enregistrée (nouvelle question)" });
    }

    const qIndex = match.questionsAsked.findIndex(
      (q) => q.question.text === question.text
    );
    if (qIndex === -1) {
      return res.status(404).json({ message: "Question introuvable" });
    }

    const answers = match.questionsAsked[qIndex].answers;
    const alreadyAnswered = answers.some(
      (a) => a.playerId.toString() === userId.toString()
    );
    if (alreadyAnswered) {
      return res
        .status(400)
        .json({ message: "Vous avez déjà répondu à cette question" });
    }

    await Match.updateOne(
      {
        _id: matchId,
        "questionsAsked.question.text": question.text,
      },
      {
        $push: {
          "questionsAsked.$.answers": {
            playerId: userId,
            selectedOption,
            isCorrect,
            answeredAt,
            score: 0,
          },
        },
      }
    );

    match = await Match.findById(matchId);

    const updatedQIndex = match.questionsAsked.findIndex(
      (q) => q.question.text === question.text
    );

    const correctAnswers = match.questionsAsked[updatedQIndex].answers
      .filter((a) => a.isCorrect)
      .sort((a, b) => new Date(a.answeredAt) - new Date(b.answeredAt));

    if (correctAnswers.length > 0) {
      const fastest = correctAnswers[0];
      if (fastest.score !== 4) {
        await Match.updateOne(
          {
            _id: matchId,
            "questionsAsked.question.text": question.text,
            "questionsAsked.answers.playerId": fastest.playerId,
          },
          {
            $set: {
              "questionsAsked.$[q].answers.$[a].score": 4,
            },
          },
          {
            arrayFilters: [
              { "q.question.text": question.text },
              { "a.playerId": fastest.playerId },
            ],
          }
        );
      }
    }

    const currentQ = match.questionsAsked[updatedQIndex];
    const io = req.app.get("io");

    if (currentQ.answers.length >= 2) {
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
          },
          answers: [],
        });

        await match.save();

        io.to(matchId.toString()).emit("next_question", {
          question: {
            text: nextQ.question,
            choices: formattedOptions,
            correctAnswer: nextQ.correctAnswer,
          },
        });
      } else {
        io.to(matchId.toString()).emit("quiz_finished", {
          message: "Le quiz est terminé ! Merci d’avoir joué.",
        });
      }
    }

    let scoreUserOne = 0;
    let scoreUserTwo = 0;

    const fullMatch = await Match.findById(matchId)
      .populate("creatorId")
      .populate("joinerId");

    fullMatch.questionsAsked.forEach((q) => {
      q.answers.forEach((a) => {
        if (a.playerId.toString() === fullMatch.creatorId._id.toString()) {
          scoreUserOne += a.score || 0;
        } else if (
          fullMatch.joinerId &&
          a.playerId.toString() === fullMatch.joinerId._id.toString()
        ) {
          scoreUserTwo += a.score || 0;
        }
      });
    });

    if (io) {
      io.to(matchId).emit("score_updated", {
        matchId,
        scoreUserOne,
        scoreUserTwo,
      });
    }

    // 🎯 Conversion Kick Logic
    if (!match.hasConversionStarted) {
      let teamToConvert = null;

      if (scoreUserOne === 4 && !match.conversionBy) {
        teamToConvert = "playerOne";
      } else if (scoreUserTwo === 4 && !match.conversionBy) {
        teamToConvert = "playerTwo";
      }

      if (teamToConvert) {
        match.hasConversionStarted = true;
        match.conversionBy = teamToConvert;
        await match.save();

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

        io.to(matchId.toString()).emit("conversion_question", {
          team: teamToConvert,
          matchId,
          question: {
            text: convQ.question,
            choices: formattedConvOptions,
            correctAnswer: convQ.correctAnswer,
          },
        });

        return res.status(200).json({ message: "Conversion déclenchée" });
      }
    }

    return res.status(200).json({ message: "Réponse enregistrée" });
  } catch (error) {
    console.error("Erreur updateMatchWithQuestion:", error);
    return res
      .status(500)
      .json({ message: "Erreur serveur", error: error.message });
  }
};

const calculateScores = async (req, res) => {
  try {
    const matchId = req.params.id;

    const match = await Match.findById(matchId)
      .populate("creatorId") // joueur 1
      .populate("joinerId"); // joueur 2

    if (!match) {
      return res.status(404).json({ message: "Match introuvable" });
    }

    let scoreUserOne = 0;
    let scoreUserTwo = 0;

    // Parcours des questions et des réponses
    if (Array.isArray(match.questionsAsked)) {
      match.questionsAsked.forEach((q) => {
        if (Array.isArray(q.answers)) {
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
        }
      });
    }

    // Émission socket pour mise à jour en temps réel
    const io = req.app.get("io");
    if (io) {
      io.to(matchId).emit("score_updated", {
        matchId,
        scoreUserOne,
        scoreUserTwo,
      });
    }

    return res.status(200).json({ scoreUserOne, scoreUserTwo });
  } catch (error) {
    console.error("Erreur dans calculateScores :", error);
    return res
      .status(500)
      .json({ message: "Erreur serveur", error: error.message });
  }
};

const getQuiz = async (req, res) => {
  res.status(200).json(Quizz);
};

const getNextQuestion = async (req, res) => {
  try {
    const matchId = req.params.id;
    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: "Match introuvable" });
    }

    const alreadyAsked = match.questionsAsked.length;
    if (alreadyAsked >= Quizz.length) {
      return res.status(200).json({ done: true });
    }

    const next = Quizz[alreadyAsked];

    return res.status(200).json({
      index: alreadyAsked,
      question: {
        text: next.question,
        choices: next.choices,
        correctAnswer: next.correctAnswer,
      },
    });
  } catch (error) {
    console.error("Erreur getNextQuestion:", error);
    return res.status(500).json({ message: "Erreur serveur" });
  }
};

const finishMatch = async (req, res) => {
  const { matchId } = req.params;
  const io = req.io;
  try {
    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });

    match.isFinished = true;
    await match.save();
    io.to(matchId).emit("match_finished", { matchId });
    return res.status(200).json({ message: "Match marked as finished" });
  } catch (error) {
    return res.status(500).json({ message: "Erreur serveur", error });
  }
};

module.exports = {
  createMatch,
  joinMatch,
  getMatchById,
  getWaitingMatches,
  updateMatchStatus,
  findFirstPendingMatch,
  cancelOldPendingMatches,
  updateMatchWithQuestion,
  calculateScores,
  getQuiz,
  getNextQuestion,
  finishMatch,
};
