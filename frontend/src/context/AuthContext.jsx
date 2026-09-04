import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import api, { tokenStore, setUnauthorizedHandler } from '../services/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  // A 401 from any endpoint means the session is gone; clear it once, centrally.
  useEffect(() => { setUnauthorizedHandler(() => setUser(null)); }, []);

  // Restore the session on load if a stored token is still valid.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.get()) { setChecking(false); return; }
      try {
        const { user: u } = await api.me();
        if (!cancelled) setUser(u);
      } catch {
        tokenStore.clear();
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { token, user: u } = await api.login({ email, password });
    tokenStore.set(token);
    setUser(u);
    return u;
  }, []);

  const signUp = useCallback(async (payload) => {
    const { token, user: u } = await api.register(payload);
    tokenStore.set(token);
    setUser(u);
    return u;
  }, []);

  const value = useMemo(
    () => ({ user, checking, signIn, signUp, signOut, isAuthenticated: Boolean(user) }),
    [user, checking, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
