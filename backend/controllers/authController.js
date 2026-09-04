import {
  hashPassword, verifyPassword, signToken, validateEmail, validatePassword,
} from '../lib/auth.js';
import { createUser, findUserByEmail, findUserById, touchLogin, getPortfolio, savePortfolio } from '../data/store.js';

const publicUser = (u) => ({ id: String(u.id ?? u._id), email: u.email, name: u.name || '' });

export async function register(req, res, next) {
  try {
    const { email, password, name, startingEquity } = req.body || {};
    if (!validateEmail(email)) return res.status(400).json({ ok: false, error: 'A valid email address is required' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ ok: false, error: pwError });

    const user = await createUser({
      email,
      name: String(name || '').trim().slice(0, 80),
      passwordHash: hashPassword(password),
    });

    // Seed the account's portfolio with its opening equity.
    const equity = Number(startingEquity) > 0 ? Number(startingEquity) : 100000;
    await savePortfolio(
      { equity, cash: equity, startingEquity: equity, peakEquity: equity, name: `${user.name || 'My'} Portfolio` },
      String(user.id ?? user._id),
    );

    res.status(201).json({ ok: true, token: signToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);

    // Identical response and comparable timing whether or not the account
    // exists, so this endpoint cannot be used to enumerate registered emails.
    const ok = user ? verifyPassword(String(password || ''), user.passwordHash) : verifyPassword('dummy', hashPassword('dummy-nonmatch'));
    if (!user || !ok) return res.status(401).json({ ok: false, error: 'Invalid email or password' });

    await touchLogin(user.id ?? user._id);
    res.json({ ok: true, token: signToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
}

export async function me(req, res, next) {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'Account not found' });
    const portfolio = await getPortfolio(req.user.id);
    res.json({
      ok: true,
      user: publicUser(user),
      portfolioSummary: {
        equity: portfolio.equity,
        cash: portfolio.cash,
        positions: portfolio.positions.length,
        portfolioHeatPct: Number((portfolio.portfolioHeatPct ?? 0).toFixed(2)),
      },
    });
  } catch (err) { next(err); }
}
