const Match = require("../models/Match");

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

    const savedMatch = await newMatch.save();

    // ✅ Emit socket event ici si tu veux notifier les autres joueurs
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

    // 1. Vérifier que le match existe
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    // 2. Vérifier que le match n’est pas déjà complet
    if (match.joinerId) {
      return res.status(400).json({ message: "This match is already full" });
    }

    // 3. Vérifier que l’équipe choisie est différente de celle du joueur 1
    if (
      match.playerOneTeam &&
      match.playerOneTeam.title.toLowerCase() ===
        playerTwoTeam.title.toLowerCase()
    ) {
      return res
        .status(400)
        .json({ message: "You cannot select the same team as Player One." });
    }

    // 4. Stocker l'équipe du joueur 2 et les autres infos
    match.playerTwoTeam = playerTwoTeam;
    match.joinerId = joinerId;
    match.status = "in-progress";
    match.startTime = new Date();

    // 5. Sauvegarder le match mis à jour
    const updatedMatch = await match.save();
    // 🎯 Émettre un événement socket au joueur 1
    req.io.emit("match_joined", {
      matchId: updatedMatch._id,
      startTime: match.startTime,
      match: updatedMatch,
    });

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

    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match introuvable" });
    }

    // Cherche si la question existe déjà
    let questionIndex = match.questionsAsked.findIndex(
      (q) => q.question.text === question.text
    );

    const isCorrect = selectedOption === question.correctOption;
    const answeredAt = new Date();

    const newAnswer = {
      playerId: userId,
      selectedOption,
      isCorrect,
      answeredAt,
      score: 0,
    };

    if (questionIndex !== -1) {
      const existingQuestion = match.questionsAsked[questionIndex];

      // Empêcher double réponse
      const alreadyAnswered = existingQuestion.answers.find(
        (a) => a.playerId.toString() === userId.toString()
      );
      if (alreadyAnswered) {
        return res
          .status(400)
          .json({ message: "Vous avez déjà répondu à cette question." });
      }

      // Ajouter la réponse
      existingQuestion.answers.push(newAnswer);

      // ⚠️ Vérifier s’il y a déjà une réponse correcte avec score = 4
      const alreadyScored = existingQuestion.answers.find((a) => a.score === 4);

      if (isCorrect && !alreadyScored) {
        // C’est la première bonne réponse → on score immédiatement
        existingQuestion.answers[existingQuestion.answers.length - 1].score = 4;
      }

      match.questionsAsked[questionIndex] = existingQuestion;
    } else {
      // Première réponse à cette question
      if (isCorrect) {
        newAnswer.score = 4; // Score immédiat si le premier à répondre est correct
      }

      match.questionsAsked.push({
        question,
        answers: [newAnswer],
      });
    }

    await match.save();
    res.status(200).json({ message: "Réponse enregistrée", match });
  } catch (error) {
    console.error("Erreur updateMatchWithQuestion:", error);
    res.status(500).json({ message: "Erreur interne", error: error.message });
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
};
