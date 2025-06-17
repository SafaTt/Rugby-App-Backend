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

router.get("/pending-first", auth, matchController.findFirstPendingMatch);

module.exports = router;
