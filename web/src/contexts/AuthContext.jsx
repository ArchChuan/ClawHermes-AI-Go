import React, { createContext, useState, useEffect, useRef } from 'react';
import api from '../services/api';

export const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef(null);

  const updateToken = (token) => {
    tokenRef.current = token;
    setAccessToken(token);
  };

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const res = await api.get('/auth/me');
        setUser(res.data.user);
        updateToken(res.data.access_token);
      } catch {
        setUser(null);
        updateToken(null);
      } finally {
        setLoading(false);
      }
    };
    restoreSession();
  }, []);

  const login = (userData, token) => {
    setUser(userData);
    updateToken(token);
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore, force local cleanup
    }
    setUser(null);
    updateToken(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, accessToken, tokenRef, loading, login, logout, setAccessToken: updateToken }}
    >
      {children}
    </AuthContext.Provider>
  );
};
