const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
  },
  organization: {
    type: String,
    default: 'Walchand College of Engineering',
  },
  role: {
    type: String,
    enum: ['member', 'admin'],
    default: 'member',
  },
  // Bumped on logout. A JWT is self-contained and stays cryptographically valid
  // until it expires, so clearing it from the browser is not enough: anyone who
  // copied the token keeps full access for the remainder of its TTL. The token
  // carries the tokenVersion it was minted with, and requireAuth compares it
  // against the current value, so bumping the number retroactively invalidates
  // every token issued before the bump - including copies held elsewhere.
  tokenVersion: {
    type: Number,
    default: 0,
  },
  lastLogoutAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
