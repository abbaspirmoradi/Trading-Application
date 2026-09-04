import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import api from '../services/api.js';
import { useAuth } from './AuthContext.jsx';

const PortfolioContext = createContext(null);

export function PortfolioProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [portfolio, setPortfolio] = useState(null);
  const [stress, setStress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    // Portfolio endpoints require a session; skip entirely while signed out.
    if (!isAuthenticated) { setPortfolio(null); setLoading(false); return null; }
    try {
      const { portfolio: pf } = await api.portfolio();
      setPortfolio(pf);
      setError(null);
      return pf;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  const refreshStress = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const { stress: s } = await api.stressTest();
      setStress(s);
    } catch { /* stress test is supplementary; failures are not fatal */ }
  }, [isAuthenticated]);

  useEffect(() => { refresh(); }, [refresh]);

  const addPosition = useCallback(async (position) => {
    const { portfolio: pf } = await api.addPosition(position);
    setPortfolio(pf);
    refreshStress();
    return pf;
  }, [refreshStress]);

  const removePosition = useCallback(async (id) => {
    const { portfolio: pf } = await api.removePosition(id);
    setPortfolio(pf);
    refreshStress();
    return pf;
  }, [refreshStress]);

  const updateEquity = useCallback(async (update) => {
    const { portfolio: pf } = await api.updatePortfolio(update);
    setPortfolio(pf);
    return pf;
  }, []);

  const value = useMemo(() => ({
    portfolio, stress, loading, error,
    refresh, refreshStress, addPosition, removePosition, updateEquity,
  }), [portfolio, stress, loading, error, refresh, refreshStress, addPosition, removePosition, updateEquity]);

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used inside a PortfolioProvider');
  return ctx;
}
