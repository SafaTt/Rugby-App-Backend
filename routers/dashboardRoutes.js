const express = require("express");
const router = express.Router();
const auth = require("../utils/middelware");
const dashboardController = require("../controllers/dashboardController");

router.get("/user-stats", auth, dashboardController.getUserDashboardStats);
router.get("/stat-by-team", auth, dashboardController.getUserTeamStats);
module.exports = router;
