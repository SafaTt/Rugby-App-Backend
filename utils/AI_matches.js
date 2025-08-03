const Match = require("../models/Match");
const Quizz = require("../models/Quizz");

const getRandomQuestion = (quizzList, alreadyAsked) => {
  const notAsked = quizzList.filter(
    (q) => !alreadyAsked.some((asked) => asked.question.text === q.question)
  );
  if (notAsked.length === 0) return null;
  const index = Math.floor(Math.random() * notAsked.length);
  return notAsked[index];
};

const startMatchAgainstAI = async (io, match) => {
  try {
    const first = getRandomQuestion(Quizz, []);
    if (!first) return;

    const formatted = Array.isArray(first.choices)
      ? first.choices.reduce((acc, choice, idx) => {
          const letters = ["A", "B", "C", "D"];
          acc[letters[idx]] = choice;
          return acc;
        }, {})
      : first.choices;

    // On stocke la question dans le match
    match.questionsAsked.push({
      question: {
        text: first.question,
        options: formatted,
        correctOption: first.correctAnswer,
        isConversion: false,
        conversionPlayerId: null,
      },
      answers: [],
    });

    match.quizStarted = true;
    await match.save();

    // On attend que le client demande explicitement la question
    io.to(match._id.toString()).emit("quiz_start", {
      matchId: match._id,
    });

    // ❌ NE PAS envoyer next_question directement ici ❌
  } catch (err) {
    console.error("Erreur démarrage IA:", err);
  }
};

module.exports = {
  startMatchAgainstAI,
  getRandomQuestion,
};
