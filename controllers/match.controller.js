const Match = require("../models/Match");
const Quizz = require("../models/Quizz");

// Créer un match (joueur 1)
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
    });
    newMatch.questionsAsked = [
      {
        question: {
          text: Quizz[0].question,
          options: Object.values(Quizz[0].choices),
          correctOption: Quizz[0].correctAnswer,
        },
        answers: [],
      },
    ];

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

    const updateExisting = await Match.findOneAndUpdate(
      {
        _id: matchId,
        "questionsAsked.question.text": question.text,
        // Empêche que ce joueur ait déjà répondu
        "questionsAsked.answers.playerId": { $ne: userId },
      },
      {
        $push: {
          "questionsAsked.$.answers": {
            playerId: userId,
            selectedOption,
            isCorrect,
            answeredAt,
            score: 0, // on corrige score après
          },
        },
      },
      { new: true }
    );

    if (updateExisting) {
      // 2. Mettre à jour le score si c'est la première bonne réponse dans cette question
      // Chercher la question mise à jour dans updateExisting
      const q = updateExisting.questionsAsked.find(
        (q) => q.question.text === question.text
      );

      // Vérifier s'il y a déjà une réponse avec score=4
      const alreadyScored = q.answers.some((a) => a.score === 4);

      if (isCorrect && !alreadyScored) {
        // Mettre à jour la dernière réponse (celle qu'on vient d'ajouter) avec score=4
        await Match.updateOne(
          {
            _id: matchId,
            "questionsAsked.question.text": question.text,
          },
          {
            $set: {
              "questionsAsked.$[q].answers.$[a].score": 4,
            },
          },
          {
            arrayFilters: [
              { "q.question.text": question.text },
              { "a.playerId": userId, "a.answeredAt": answeredAt },
            ],
          }
        );
      }
    } else {
      // 3. Sinon, question non encore posée -> création de la question + première réponse
      let scoreToSet = 0;
      if (isCorrect) scoreToSet = 4;

      await Match.findByIdAndUpdate(
        matchId,
        {
          $push: {
            questionsAsked: {
              question,
              answers: [
                {
                  playerId: userId,
                  selectedOption,
                  isCorrect,
                  answeredAt,
                  score: scoreToSet,
                },
              ],
            },
          },
        },
        { new: true }
      );
    }

    // 4. Ajouter la prochaine question si besoin
    const matchAfter = await Match.findById(matchId);

    if (matchAfter.questionsAsked.length < Quizz.length) {
      const next = Quizz[matchAfter.questionsAsked.length];

      await Match.findByIdAndUpdate(matchId, {
        $push: {
          questionsAsked: {
            question: {
              text: next.question,
              options: Object.values(next.choices),
              correctOption: next.correctAnswer,
            },
            answers: [],
          },
        },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(matchId).emit("next_question", {
          question: {
            text: next.question,
            choices: next.choices,
            correctAnswer: next.correctAnswer,
          },
        });
      }
    }

    res.status(200).json({ message: "Réponse enregistrée" });
  } catch (error) {
    console.error("Erreur updateMatchWithQuestion:", error);
    res.status(500).json({ message: "Erreur interne", error: error.message });
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

    // Ajouter au match les questions posées
    match.questionsAsked.push({
      question: {
        text: next.question,
        options: Object.values(next.choices),
        correctOption: next.correctAnswer,
      },
      answers: [], // personne n’a encore répondu
    });

    await match.save();

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
};
