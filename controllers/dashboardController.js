const Match = require("../models/Match");
const User = require("../models/User");

function calculatePlayerScore(match, userId) {
  let totalScore = 0;
  if (!match.questionsAsked) return 0;
  match.questionsAsked.forEach((questionsAsked) => {
    if (!questionsAsked.answers) return;
    questionsAsked.answers.forEach((answer) => {
      if (answer.playerId.toString() === userId.toString()) {
        totalScore += answer.score || 0;
      }
    });
  });
  return totalScore;
}

const getUserDashboardStats = async (req, res) => {
  try {
    const userId = req.user._id;

    const matches = await Match.find({
      isFinished: true,
      $or: [{ creatorId: userId }, { joinerId: userId }],
    });

    if (!matches.length) {
      return res
        .status(404)
        .json({ message: "Aucun match trouvé pour cet utilisateur." });
    }

    let totalMatches = matches.length;
    let totalWins = 0;
    let totalLosses = 0;
    let bestScore = 0;
    const teamMap = new Map();
    const scoreByUser = new Map();
    const matchHistory = [];

    for (const match of matches) {
      const userScore = calculatePlayerScore(match, userId);
      if (userScore > bestScore) bestScore = userScore;

      let userTeam, opponentTeam, opponentId;

      if (match.creatorId.toString() === userId.toString()) {
        userTeam = match.playerOneTeam;
        opponentTeam = match.playerTwoTeam;
        opponentId = match.joinerId;
      } else {
        userTeam = match.playerTwoTeam;
        opponentTeam = match.playerOneTeam;
        opponentId = match.creatorId;
      }

      // Ajouter au tableau d'équipes jouées
      if (userTeam?.title) {
        teamMap.set(userTeam.title, {
          title: userTeam.title,
          color: userTeam.color,
          textColor: userTeam.textColor,
        });
      }

      const opponentScore = opponentId
        ? calculatePlayerScore(match, opponentId)
        : 0;

      let result = "draw";
      if (userScore > opponentScore) {
        totalWins++;
        result = "win";
      } else if (userScore < opponentScore) {
        totalLosses++;
        result = "loss";
      }

      // Ajouter au matchHistory
      matchHistory.push({
        matchId: match._id,
        date: match.createdAt || match.date || null,
        teamName: userTeam?.title || "Équipe inconnue",
        teamColor: userTeam?.color || null,
        teamTextColor: userTeam?.textColor || null,
        opponentTeamName: opponentTeam?.title || "Adversaire inconnu",
        opponentId: opponentId || null,
        opponentTeamColor: opponentTeam?.color || null,
        opponentTeamTextColor: opponentTeam?.textColor || null,
        result,
        userScore,
        opponentScore,
      });

      // Rank (meilleur score global par utilisateur)
      if (match.creatorId) {
        const creatorId = match.creatorId.toString();
        const creatorScore = calculatePlayerScore(match, creatorId);
        scoreByUser.set(
          creatorId,
          Math.max(scoreByUser.get(creatorId) || 0, creatorScore)
        );
      }
      if (match.joinerId) {
        const joinerId = match.joinerId.toString();
        const joinerScore = calculatePlayerScore(match, joinerId);
        scoreByUser.set(
          joinerId,
          Math.max(scoreByUser.get(joinerId) || 0, joinerScore)
        );
      }
    }

    const sortedScoreByUser = Array.from(scoreByUser.entries()).sort(
      (a, b) => b[1] - a[1]
    );
    const rank =
      sortedScoreByUser.findIndex(([id]) => id === userId.toString()) + 1;

    const user = await User.findById(userId).select("pseudo");

    return res.json({
      pseudo: user.pseudo,
      totalMatches,
      totalWins,
      totalLosses,
      bestScore,
      teams: Array.from(teamMap.values()),
      rank,
      matchHistory, // ✅ Historique ajouté ici
    });
  } catch (error) {
    console.error("Erreur getUserDashboardStats:", error);
    return res
      .status(500)
      .json({ message: "Erreur serveur", error: error.message });
  }
};

const getUserTeamStats = async (req, res) => {
  try {
    const userId = req.user._id;

    const matches = await Match.find({
      isFinished: true,
      $or: [{ creatorId: userId }, { joinerId: userId }],
    });

    if (!matches.length) {
      return res
        .status(404)
        .json({ message: "Aucun match trouvé pour cet utilisateur." });
    }

    const teamStatsMap = new Map();

    for (const match of matches) {
      const userScore = calculatePlayerScore(match, userId);

      let userTeam, opponentId, opponentScore;
      let isGoldenPoint = match.isGoldenPoint || false;

      if (match.creatorId.toString() === userId.toString()) {
        userTeam = match.playerOneTeam;
        opponentId = match.joinerId;
      } else {
        userTeam = match.playerTwoTeam;
        opponentId = match.creatorId;
      }

      opponentScore = opponentId ? calculatePlayerScore(match, opponentId) : 0;

      // Déterminer le résultat
      let result = "draw";
      if (userScore > opponentScore) result = "win";
      else if (userScore < opponentScore) result = "loss";

      // Initialiser les stats pour cette équipe si elle n'existe pas encore
      if (!teamStatsMap.has(userTeam.title)) {
        teamStatsMap.set(userTeam.title, {
          title: userTeam.title,
          color: userTeam.color,
          textColor: userTeam.textColor,
          played: 0,
          won: 0,
          lost: 0,
          goldenPoint: 0,
        });
      }

      const teamData = teamStatsMap.get(userTeam.title);
      teamData.played += 1;
      if (result === "win") teamData.won += 1;
      if (result === "loss") teamData.lost += 1;
      if (isGoldenPoint) teamData.goldenPoint += 1;

      teamStatsMap.set(userTeam.title, teamData);
    }

    // Calculer le pourcentage de victoire pour chaque équipe
    const teamStatsArray = Array.from(teamStatsMap.values()).map((team) => ({
      ...team,
      winningPercentage:
        team.played > 0 ? Math.round((team.won / team.played) * 100) : 0,
    }));

    return res.json({
      userId,
      teamStats: teamStatsArray,
    });
  } catch (error) {
    console.error("Erreur getUserTeamStats:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

module.exports = { getUserDashboardStats, getUserTeamStats };
