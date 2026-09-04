import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  name: { type: String, default: '' },
  // "salt:hash" from lib/auth.js — the plaintext never leaves the request handler.
  passwordHash: { type: String, required: true },
  lastLoginAt: { type: Date },
}, { timestamps: true });

// Ensure the hash can never be serialised into a response by accident.
UserSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

export default mongoose.models.User || mongoose.model('User', UserSchema);
