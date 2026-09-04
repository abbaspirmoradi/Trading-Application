// WebSocket client with automatic reconnection and backoff.
//
// The dashboard treats the socket as a nice-to-have: if it never connects, the
// UI still works entirely over REST — only the live tick updates are missing.

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

class MarketSocket {
  constructor() {
    this.ws = null;
    this.listeners = new Set();
    this.tickers = [];
    this.reconnectDelay = 1000;
    this.status = 'disconnected';
    this.shouldRun = false;
  }

  connect() {
    this.shouldRun = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.setStatus('connecting');
    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.setStatus('connected');
      this.reconnectDelay = 1000;
      if (this.tickers.length) this.subscribe(this.tickers);
    };

    this.ws.onmessage = (event) => {
      try {
        this.emit(JSON.parse(event.data));
      } catch { /* ignore malformed frames */ }
    };

    this.ws.onclose = () => {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => this.ws?.close();
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.8, 15000);
  }

  subscribe(tickers) {
    this.tickers = tickers;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', tickers }));
    }
  }

  on(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(msg) {
    this.listeners.forEach((l) => l(msg));
  }

  setStatus(status) {
    this.status = status;
    this.emit({ type: 'status', status });
  }

  disconnect() {
    this.shouldRun = false;
    this.ws?.close();
  }
}

export const marketSocket = new MarketSocket();
export default marketSocket;
