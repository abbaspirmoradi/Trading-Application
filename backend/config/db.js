import mongoose from 'mongoose';

let connected = false;

/**
 * Mongo is optional: the analysis engine is pure and works without persistence.
 * If the connection fails we degrade to in-memory mode rather than crashing,
 * so the app is runnable with zero infrastructure.
 */
/** Strips credentials so a connection string is never written to a log. */
function redact(uri) {
  return String(uri).replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

export async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/trading_app';
  const isProduction = process.env.NODE_ENV === 'production';

  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(uri, {
      // Atlas clusters can be slow to wake; 3s was tuned for a local mongod.
      serverSelectionTimeoutMS: isProduction ? 15000 : 8000,
      retryWrites: true,
    });
    connected = true;
    console.log(`[db] connected: ${redact(uri)} (database: ${mongoose.connection.name})`);
  } catch (err) {
    connected = false;
    // In production the in-memory fallback is not a graceful degradation, it is
    // silent data loss: every account and position would vanish on restart.
    if (isProduction) {
      console.error(`[db] FATAL: cannot reach MongoDB at ${redact(uri)} — ${err.message}`);
      console.error('[db] Refusing to start in production without a database.');
      throw err;
    }
    console.warn(`[db] unavailable (${err.message}) — running in ephemeral mode, nothing will be persisted`);
  }
  return connected;
}

/** Emitted on later disconnects so a dropped Atlas link is visible in the logs. */
mongoose.connection.on('disconnected', () => {
  if (connected) console.warn('[db] connection lost — Mongoose will retry');
});
mongoose.connection.on('reconnected', () => console.log('[db] reconnected'));

export function isDbConnected() {
  return connected && mongoose.connection.readyState === 1;
}
