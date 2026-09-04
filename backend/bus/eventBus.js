// Event bus abstraction for inter-agent / inter-service messaging.
//
// Two drivers behind one interface:
//   memory — an in-process EventEmitter (default). Zero infrastructure.
//   kafka  — kafkajs producer/consumer against a real broker.
//
// The orchestrator and WebSocket layer only ever call publish()/subscribe(), so
// moving from a single process to a Kafka-backed microservice deployment is a
// config change (EVENT_BUS=kafka), not a rewrite. Kafka is an optional
// dependency: if it is not installed or the broker is unreachable, the bus logs
// once and falls back to memory rather than failing the request path.

import { EventEmitter } from 'node:events';

export const TOPICS = {
  ANALYSIS_REQUESTED: 'analysis.requested',
  AGENTS_COMPLETED: 'analysis.agents.completed',
  DECISION: 'analysis.decision',
  PRICE_TICK: 'market.price.tick',
  PORTFOLIO_UPDATED: 'portfolio.updated',
};

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

let driver = 'memory';
let producer = null;
let kafkaReady = false;

export async function initEventBus() {
  const requested = (process.env.EVENT_BUS || 'memory').toLowerCase();
  if (requested !== 'kafka') {
    console.log('[bus] driver: memory (in-process EventEmitter)');
    return 'memory';
  }

  try {
    const { Kafka, logLevel } = await import('kafkajs');
    const kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'trading-agents',
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      logLevel: logLevel.ERROR,
    });
    producer = kafka.producer();
    await producer.connect();
    kafkaReady = true;
    driver = 'kafka';
    console.log(`[bus] driver: kafka (${process.env.KAFKA_BROKERS})`);

    // Mirror every Kafka topic back onto the local emitter so in-process
    // subscribers (the WebSocket fan-out) work identically under both drivers.
    const consumer = kafka.consumer({ groupId: `${process.env.KAFKA_CLIENT_ID || 'trading-agents'}-gateway` });
    await consumer.connect();
    for (const topic of Object.values(TOPICS)) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }
    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        try {
          emitter.emit(topic, JSON.parse(message.value.toString()));
        } catch { /* malformed payloads are dropped, not fatal */ }
      },
    });
  } catch (err) {
    driver = 'memory';
    kafkaReady = false;
    console.warn(`[bus] kafka unavailable (${err.message}) — falling back to the in-memory driver`);
  }
  return driver;
}

export async function publish(topic, payload) {
  const envelope = { topic, payload, ts: new Date().toISOString() };

  if (driver === 'kafka' && kafkaReady && producer) {
    try {
      await producer.send({ topic, messages: [{ value: JSON.stringify(envelope) }] });
      return; // the consumer mirrors it back onto the emitter
    } catch (err) {
      console.warn(`[bus] kafka publish failed for ${topic} (${err.message}) — emitting locally`);
    }
  }
  emitter.emit(topic, envelope);
}

export function subscribe(topic, handler) {
  emitter.on(topic, handler);
  return () => emitter.off(topic, handler);
}

export function busDriver() {
  return driver;
}

export async function shutdownEventBus() {
  if (producer) {
    try { await producer.disconnect(); } catch { /* already down */ }
  }
}
