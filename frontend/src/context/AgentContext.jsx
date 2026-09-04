import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import api from '../services/api.js';

const AgentContext = createContext(null);

const STORAGE_KEY = 'trading-app.activeAgents';

/**
 * Owns the agent registry and which agents are currently active. The active set
 * survives a reload (localStorage) because an analyst's agent configuration is
 * a deliberate choice, not incidental UI state.
 */
export function AgentProvider({ children }) {
  const [agents, setAgents] = useState([]);
  const [activeIds, setActiveIds] = useState(null); // null until the registry loads
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { agents: list } = await api.agents();
        if (cancelled) return;
        setAgents(list);

        const stored = localStorage.getItem(STORAGE_KEY);
        const valid = list.map((a) => a.agentId);
        if (stored) {
          const parsed = JSON.parse(stored).filter((id) => valid.includes(id));
          setActiveIds(parsed.length ? parsed : valid);
        } else {
          setActiveIds(valid);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (activeIds) localStorage.setItem(STORAGE_KEY, JSON.stringify(activeIds));
  }, [activeIds]);

  const toggle = useCallback((agentId) => {
    setActiveIds((prev) => (prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]));
  }, []);

  const selectAll = useCallback(() => setActiveIds(agents.map((a) => a.agentId)), [agents]);
  const clearAll = useCallback(() => setActiveIds([]), []);
  const resetToDefault = useCallback(
    () => setActiveIds(agents.filter((a) => a.defaultActive).map((a) => a.agentId)),
    [agents],
  );
  const selectCluster = useCallback((cluster) => {
    setActiveIds((prev) => {
      const inCluster = agents.filter((a) => a.cluster === cluster).map((a) => a.agentId);
      const allOn = inCluster.every((id) => prev.includes(id));
      return allOn ? prev.filter((id) => !inCluster.includes(id)) : [...new Set([...prev, ...inCluster])];
    });
  }, [agents]);

  const value = useMemo(() => ({
    agents,
    activeIds: activeIds ?? [],
    activeCount: activeIds?.length ?? 0,
    totalCount: agents.length,
    isActive: (id) => (activeIds ?? []).includes(id),
    toggle,
    selectAll,
    clearAll,
    resetToDefault,
    selectCluster,
    loading,
    error,
  }), [agents, activeIds, loading, error, toggle, selectAll, clearAll, resetToDefault, selectCluster]);

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgents() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgents must be used inside an AgentProvider');
  return ctx;
}
