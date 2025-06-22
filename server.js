const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const authRoutes = require("./routers/authRoutes");
const matchRoutes = require("./routers/matchRoutes");
dotenv.config();
console.log("JWT_SECRET:", process.env.JWT_SECRET);
const app = express();
app.use(cors());
app.use(express.json());
app.use(cors({ origin: "*" }));

app.use("/api/auth", authRoutes);
app.use("/api/match", matchRoutes);

const port = process.env.PORT || 5000;

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.log("Error connecting to MongoDB", err));

// Define routes
app.get("/", (req, res) => {
  res.send("Welcome to the backend!");
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
