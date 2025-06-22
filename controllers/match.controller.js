const Match = require("../models/Match");

// Créer un match (joueur 1)
const createMatch = async (req, res) => {
  try {
    const { competition, duration, playerOneTeam } = req.body;
    const creatorId = req.user._id;

    const newMatch = new Match({
      competition,
      duration,
      playerOneTeam,
      creatorId,
    });

    const savedMatch = await newMatch.save();
    res.status(201).json(savedMatch);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Erreur lors de la création du match", error });
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

    // 5. Sauvegarder le match mis à jour
    const updatedMatch = await match.save();

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

module.exports = {
  createMatch,
  joinMatch,
  getMatchById,
  getWaitingMatches,
  updateMatchStatus,
  findFirstPendingMatch,
};
