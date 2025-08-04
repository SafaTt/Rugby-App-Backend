const express = require("express");
const router = express.Router();
const auth = require("../utils/middelware"); // ton middleware d’authentification
const dashboardController = require("../controllers/dashboardController");

router.get("/user-stats/:userId", auth, dashboardController.getUserDashboardStats);

module.exports = router;
