import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080',
  timeout: 10000,
  withCredentials: true,
});

let _tokenRef = { current: null };

export const setupApiInterceptors = (tokenRef, onLogout) => {
  _tokenRef = tokenRef;

  api.interceptors.request.use(
    (config) => {
      const token = _tokenRef.current;
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
      return config;
    },
    (error) => Promise.reject(error)
  );

  let isRefreshing = false;
  let pendingQueue = [];

  const processQueue = (error, token = null) => {
    pendingQueue.forEach((p) => (error ? p.reject(error) : p.resolve(token)));
    pendingQueue = [];
  };

  api.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      if (error.response?.status === 401 && !originalRequest._retry) {
        if (isRefreshing) {
          return new Promise((resolve, reject) => {
            pendingQueue.push({ resolve, reject });
          }).then((token) => {
            originalRequest.headers['Authorization'] = `Bearer ${token}`;
            return api(originalRequest);
          });
        }

        originalRequest._retry = true;
        isRefreshing = true;

        try {
          const res = await api.post('/auth/refresh');
          const newToken = res.data.access_token;
          _tokenRef.current = newToken;
          processQueue(null, newToken);
          originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
          return api(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          onLogout?.();
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }

      return Promise.reject(error);
    }
  );
};

// Health
export const checkHealth = () => api.get('/health');

// Auth
export const getMe = () => api.get('/auth/me');
export const postLogout = () => api.post('/auth/logout');
export const postRefresh = () => api.post('/auth/refresh');

// Tenant
export const createTenant = (data) => api.post('/tenants', data);
export const joinTenant = (inviteCode) => api.post('/tenants/join', { invite_code: inviteCode });
export const getTenantMembers = () => api.get('/tenant/members');
export const inviteMember = (data) => api.post('/tenant/members/invite', data);
export const removeMember = (userId) => api.delete(`/tenant/members/${userId}`);
export const updateTenant = (data) => api.put('/tenant/settings', data);
export const getAllTenants = () => api.get('/admin/tenants');
export const setTenantEnabled = (tenantId, enabled) => api.patch(`/admin/tenants/${tenantId}`, { enabled });

// Skills
export const getAllSkills = () => api.get('/skills');
export const getSkillById = (id) => api.get(`/skills/${id}`);
export const createSkill = (data) => api.post('/skills', data);
export const updateSkill = (id, data) => api.put(`/skills/${id}`, data);
export const deleteSkill = (id) => api.delete(`/skills/${id}`);

// Agents
export const getAllAgents = () => api.get('/agents');
export const getAgentById = (id) => api.get(`/agents/${id}`);
export const createAgent = (data) => api.post('/agents', data);
export const executeAgent = (id, task) => api.post(`/agents/${id}/execute`, task);

// Memory
export const createSession = (data) => api.post('/memory/sessions', data);
export const addMemory = (data) => api.post('/memory', data);
export const getMemoryById = (id) => api.get(`/memory/${id}`);
export const searchMemory = (data) => api.post('/memory/search', data);
export const deleteMemory = (id) => api.delete(`/memory/${id}`);
export const getMemoryStats = (params) => api.get('/memory/stats', { params });
export const clearSession = (sessionId, params) => api.delete(`/memory/session/${sessionId}`, { params });
export const getMemoryEntities = (params) => api.get('/memory/entities', { params });
export const extractEntities = (data) => api.post('/memory/extract-entities', data);
export const getMemorySummary = (sessionId, params) => api.get(`/memory/summary/${sessionId}`, { params });

export default api;
