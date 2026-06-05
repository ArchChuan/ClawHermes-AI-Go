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

  const buildUser = (meData, tenantName) => ({
    sub: meData.sub,
    tenant_id: meData.tenant_id,
    role: meData.role,
    global_role: meData.global_role,
    current_tenant: meData.tenant_id ? { id: meData.tenant_id, name: tenantName || meData.tenant_id } : null,
    avatar_url: meData.avatar_url || '',
    github_login: meData.github_login || '',
  });

  const fetchTenantName = async (token) => {
    try {
      const res = await api.get('/tenant/settings', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        _retry: true,
      });
      return res.data.tenant_name || '';
    } catch {
      return '';
    }
  };

  useEffect(() => {
    const restoreSession = async () => {
      const savedToken = localStorage.getItem('access_token');

      if (savedToken) {
        try {
          const [meRes, tenantName] = await Promise.all([
            api.get('/auth/me', { headers: { Authorization: `Bearer ${savedToken}` }, _retry: true }),
            fetchTenantName(savedToken),
          ]);
          updateToken(savedToken);
          setUser(buildUser(meRes.data, tenantName));
          setLoading(false);
          return;
        } catch {
          localStorage.removeItem('access_token');
        }
      }

      try {
        const refreshRes = await api.post('/auth/refresh');
        const token = refreshRes.data.access_token;
        updateToken(token);
        localStorage.setItem('access_token', token);

        const [meRes, tenantName] = await Promise.all([
          api.get('/auth/me', { headers: { Authorization: `Bearer ${token}` }, _retry: true }),
          fetchTenantName(token),
        ]);
        setUser(buildUser(meRes.data, tenantName));
      } catch {
        setUser(null);
        updateToken(null);
      } finally {
        setLoading(false);
      }
    };
    restoreSession();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = (userData, token) => {
    setUser(userData);
    updateToken(token);
    if (token) {
      localStorage.setItem('access_token', token);
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore, force local cleanup
    }
    localStorage.removeItem('access_token');
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
