import axios from 'axios';

// 创建 axios 实例
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080',
  timeout: 10000,
});

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    // 可以在这里添加认证 token
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.error('API Error:', error);
    return Promise.reject(error);
  }
);

// Health Check
export const checkHealth = () => api.get('/health');

// Skills API
export const getAllSkills = () => api.get('/skills');
export const getSkillById = (id) => api.get(`/skills/${id}`);
export const createSkill = (data) => api.post('/skills', data);
export const updateSkill = (id, data) => api.put(`/skills/${id}`, data);
export const deleteSkill = (id) => api.delete(`/skills/${id}`);
// 移除了 executeSkill 函数，因为技能只能通过代理执行

// Agents API
export const getAllAgents = () => api.get('/agents');
export const getAgentById = (id) => api.get(`/agents/${id}`);
export const createAgent = (data) => api.post('/agents', data);
export const executeAgent = (id, task) => api.post(`/agents/${id}/execute`, task);

// Memory API
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