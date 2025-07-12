const express = require("express");
const router = express.Router();
const auth = require("../utils/middelware");
const matchController = require("../controllers/match.controller");

// ✅ Créer un match (joueur 1)
router.post("/create", auth, matchController.createMatch);

// ✅ Rejoindre un match (joueur 2)
router.put("/join/:id", auth, matchController.joinMatch);

// ✅ Obtenir un match par ID
router.get("/getMatch/:id", auth, matchController.getMatchById);

// ✅ Lister les matchs en attente (waiting)
router.get("/allWaitingMatchs", auth, matchController.getWaitingMatches);

// ✅ Mettre à jour le statut d’un match (optionnel)
router.patch("/status/:id", auth, matchController.updateMatchStatus);

router.post("/pending-first", auth, matchController.findFirstPendingMatch);

router.post("/matches/clean", async (req, res) => {
  try {
    await matchController.cancelOldPendingMatches();
    res.status(200).json({ message: "Old matches cleaned" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/question", auth, matchController.updateMatchWithQuestion);
router.get("/calcul-score/:id", matchController.calculateScores);
router.get("/quiz", matchController.getQuiz);
router.get("/:id/next-question", matchController.getNextQuestion);
// routes/matchRoutes.ts
router.patch("/:matchId/finish", matchController.finishMatch);
router.patch("/cancel/:matchId", matchController.cancelMatch);

module.exports = router;
