// Thin REST client. Every call funnels through `request` so error handling,
// the JSON envelope ({ ok, ... }) and the auth header live in one place.

const BASE = '/api';
const TOKEN_KEY = 'trading-app.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

// Set by AuthContext so a 401 anywhere in the app triggers a single, central
// sign-out rather than each caller inventing its own handling.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = tokenStore.get();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && token) {
    tokenStore.clear();
    onUnauthorized();
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  if (!res.ok || json.ok === false) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

export const api = {
  // --- auth ---
  register: (payload) => request('/auth/register', { method: 'POST', body: payload, auth: false }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload, auth: false }),
  me: () => request('/auth/me'),

  // --- reference ---
  health: () => request('/health', { auth: false }),
  pipeline: () => request('/pipeline', { auth: false }),
  agents: () => request('/agents', { auth: false }),

  // --- analysis ---
  analyze: (ticker, activeAgents, timeframe = '1D') =>
    request('/analyze', { method: 'POST', body: { ticker, activeAgents, timeframe } }),
  analyzeBatch: (tickers, activeAgents) =>
    request('/analyze/batch', { method: 'POST', body: { tickers, activeAgents } }),
  chart: (ticker, days = 400) => request(`/chart/${ticker}?days=${days}`),
  marketOverview: (tickers) => request(`/market/overview${tickers ? `?tickers=${tickers.join(',')}` : ''}`),
  logs: (limit = 20) => request(`/logs?limit=${limit}`),
  backtest: (ticker, permutations = 200) =>
    request('/backtest', { method: 'POST', body: { ticker, permutations } }),

  // --- portfolio ---
  portfolio: () => request('/portfolio'),
  updatePortfolio: (update) => request('/portfolio', { method: 'PATCH', body: update }),
  addPosition: (position) => request('/portfolio/positions', { method: 'POST', body: position }),
  patchPosition: (id, patch) => request(`/portfolio/positions/${id}`, { method: 'PATCH', body: patch }),
  removePosition: (id) => request(`/portfolio/positions/${id}`, { method: 'DELETE' }),
  stressTest: () => request('/portfolio/stress-test'),

  // --- advisor & screener ---
  reviewPortfolio: (activeAgents) =>
    request('/portfolio/review', { method: 'POST', body: { activeAgents } }),
  dailyPicks: ({ limit = 10, refresh = false, activeAgents } = {}) =>
    request(`/picks?limit=${limit}${refresh ? '&refresh=true' : ''}`, { method: 'POST', body: { activeAgents, limit } }),
};

export default api;
