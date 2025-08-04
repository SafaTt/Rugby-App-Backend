const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  pseudo: {
    type: String,
    required: true,
    trim: true //Supprimer les espaces blanc au début et à la fin de la valeur avant de l'enregistrer
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
