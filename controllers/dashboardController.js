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
        const userId = req.params.userId;

        const matches = await Match.find({
            isFinished: true,
            $or: [
                { creatorId: userId },
                { joinerId: userId }
            ],
        });

        if (!matches.length) {
            return res.status(404).json({ message: "aucun match trouvé pour cet utilisateur." });
        }

        let totalMatches = matches.length;
        let totalWins = 0;
        let totalLosses = 0;
        let bestScore = 0;
        const teamMap = new Map();
        const scoreByUser = new Map();

        for (const match of matches) {
            const userScore = calculatePlayerScore(match, userId);
            if (userScore > bestScore) bestScore = userScore;

            if (match.creatorId.toString() === userId.toString() && match.playerOneTeam?.title) {
                teamMap.set(match.playerOneTeam.title, {titile: match.playerOneTeam.title, color: match.playerOneTeam.color, textColor: match.playerOneTeam.textColor});
            } else if (match.joinerId?.toString() === userId.toString() && match.playerTwoTeam?.title) {
                teamMap.set(match.playerTwoTeam.title, {title: match.playerTwoTeam.title, color:  match.playerTwoTeam.color, tetxtColor: match.playerTwoTeam.textColor});
            }

            let opponentId = match.creatorId.toString() === userId.toString()
                ? match.joinerId
                : match.creatorId;

            const opponentScore = opponentId ? calculatePlayerScore(match, opponentId) : 0;

            if (userScore > opponentScore) totalWins++;
            else if (userScore < opponentScore) totalLosses++;

            // Score max par user
            if (match.creatorId) {
                const creatorId = match.creatorId.toString();
                const creatorScore = calculatePlayerScore(match, creatorId);
                scoreByUser.set(creatorId, Math.max(scoreByUser.get(creatorId) || 0, creatorScore));
            }
            if (match.joinerId) {
                const joinerId = match.joinerId.toString();
                const joinerScore = calculatePlayerScore(match, joinerId);
                scoreByUser.set(joinerId, Math.max(scoreByUser.get(joinerId) || 0, joinerScore));
            }
        }

        const sortedScoreByUser = Array.from(scoreByUser.entries()).sort((a, b) => b[1] - a[1]);
        const rank = sortedScoreByUser.findIndex(([id]) => id === userId.toString()) + 1;

        const user = await User.findById(userId).select("pseudo");

        return res.json({
            pseudo: user.pseudo,
            totalMatches,
            totalWins,
            totalLosses,
            bestScore,
            teams: Array.from(teamMap.values()),
            rank,
        });

    } catch (error) {
        console.error("Erreur getUserDashboardStats:", error);
        return res.status(500).json({ message: "Erreur serveur", error: error.message });
    }
};

module.exports = { getUserDashboardStats };
