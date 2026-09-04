import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { AgentProvider } from './context/AgentContext.jsx';
import { PortfolioProvider } from './context/PortfolioContext.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AgentProvider>
        <PortfolioProvider>
          <App />
        </PortfolioProvider>
      </AgentProvider>
    </AuthProvider>
  </React.StrictMode>,
);
