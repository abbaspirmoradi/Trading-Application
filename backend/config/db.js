import mongoose from 'mongoose';

let connected = false;

/**
 * Mongo is optional: the analysis engine is pure and works without persistence.
 * If the connection fails we degrade to in-memory mode rather than crashing,
 * so the app is runnable with zero infrastructure.
 */
export async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/trading_app';
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    connected = true;
    console.log(`[db] connected: ${uri}`);
  } catch (err) {
    connected = false;
    console.warn(`[db] unavailable (${err.message}) — running in ephemeral mode, nothing will be persisted`);
  }
  return connected;
}

export function isDbConnected() {
  return connected && mongoose.connection.readyState === 1;
}
