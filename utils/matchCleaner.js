const { cancelOldPendingMatches } = require("../controllers/match.controller");

// Fonction qui tourne toutes les minutes
const startMatchCleaner = () => {
  setInterval(async () => {
    try {
      await cancelOldPendingMatches();
    } catch (error) {
      console.error("❌ Error cleaning old matches:", error.message);
    }
  }, 30 * 1000); // 60 000 ms = 1 min
};

module.exports = { startMatchCleaner };
