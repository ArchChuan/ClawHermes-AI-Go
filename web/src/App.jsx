import React, { useState, useEffect } from 'react';
import { Layout, Menu, Space, Typography, Dropdown, Avatar } from 'antd';
import {
  AppstoreOutlined, PlusCircleOutlined, HistoryOutlined, DashboardOutlined,
  RobotOutlined, CommentOutlined, DatabaseOutlined, UserOutlined, LogoutOutlined,
  TeamOutlined, SettingOutlined, GlobalOutlined,
} from '@ant-design/icons';
import { Routes, Route, useNavigate, Link, useLocation } from 'react-router-dom';

import SkillsListPage from './pages/SkillsListPage';
import CreateSkillPage from './pages/CreateSkillPage';
import ExecutionHistoryPage from './pages/ExecutionHistoryPage';
import DashboardPage from './pages/DashboardPage';
import AgentsListPage from './pages/AgentsListPage';
import CreateAgentPage from './pages/CreateAgentPage';
import AgentChatPage from './pages/AgentChatPage';
import MemoryPage from './pages/MemoryPage';
import LoginPage from './pages/auth/LoginPage';
import CallbackPage from './pages/auth/CallbackPage';
import OnboardingPage from './pages/auth/OnboardingPage';
import MembersPage from './pages/tenant/MembersPage';
import SettingsPage from './pages/tenant/SettingsPage';
import TenantsListPage from './pages/admin/TenantsListPage';
import PrivateRoute from './components/PrivateRoute';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './hooks/useAuth';
import { setupApiInterceptors, checkHealth } from './services/api';

const { Header, Content, Sider } = Layout;
const { Title } = Typography;

const AppInner = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [connected, setConnected] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, tokenRef } = useAuth();

  useEffect(() => {
    setupApiInterceptors(tokenRef, () => { logout(); navigate('/login', { replace: true }); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    checkHealth().then(() => setConnected(true)).catch(() => setConnected(false));
  }, []);

  const isAuthPage = ['/login', '/auth/callback', '/onboarding'].some(p => location.pathname.startsWith(p));

  if (isAuthPage) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<CallbackPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
      </Routes>
    );
  }

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: <Link to="/">仪表盘</Link> },
    { key: '/skills', icon: <AppstoreOutlined />, label: <Link to="/skills">技能管理</Link> },
    { key: '/skills/create', icon: <PlusCircleOutlined />, label: <Link to="/skills/create">创建技能</Link> },
    { key: '/agents', icon: <RobotOutlined />, label: <Link to="/agents">智能代理</Link> },
    { key: '/agents/create', icon: <PlusCircleOutlined />, label: <Link to="/agents/create">创建代理</Link> },
    { key: '/chat', icon: <CommentOutlined />, label: <Link to="/chat">代理对话</Link> },
    { key: '/memory', icon: <DatabaseOutlined />, label: <Link to="/memory">记忆管理</Link> },
    { key: '/history', icon: <HistoryOutlined />, label: <Link to="/history">执行历史</Link> },
    ...(user?.current_tenant ? [{ key: '/tenant/members', icon: <TeamOutlined />, label: <Link to="/tenant/members">成员管理</Link> }] : []),
    ...(user?.global_role === 'global_admin' ? [{ key: '/admin/tenants', icon: <GlobalOutlined />, label: <Link to="/admin/tenants">全局租户</Link> }] : []),
  ];

  const userMenuItems = [
    ...(user?.current_tenant ? [{ key: 'members', icon: <TeamOutlined />, label: <Link to="/tenant/members">成员管理</Link> }] : []),
    ...(user?.role === 'admin' ? [{ key: 'settings', icon: <SettingOutlined />, label: <Link to="/tenant/settings">租户设置</Link> }] : []),
    ...(user?.global_role === 'global_admin' ? [{ key: 'admin', icon: <GlobalOutlined />, label: <Link to="/admin/tenants">全局管理</Link> }] : []),
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true, onClick: () => { logout(); navigate('/login', { replace: true }); } },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed}
        style={{ overflow: 'auto', height: '100vh', position: 'fixed', left: 0, top: 0, bottom: 0 }}>
        <div style={{ padding: '16px', textAlign: 'center' }}>
          <Title style={{ color: 'white', fontSize: '16px' }} ellipsis>ClawHermes AI</Title>
        </div>
        <Menu theme="dark" selectedKeys={[location.pathname]} mode="inline" items={menuItems}
          onClick={({ key }) => navigate(key)} />
      </Sider>

      <Layout style={{ marginLeft: collapsed ? 80 : 200 }}>
        <Header style={{ padding: 0, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: '16px' }}>
          <Space>
            <span>状态:</span>
            <span style={{ color: connected ? 'green' : 'red' }}>{connected ? '已连接' : '未连接'}</span>
            {user?.current_tenant?.name && (
              <>
                <span style={{ color: '#bbb' }}>|</span>
                <span style={{ color: '#1677ff', fontWeight: 500 }}>{user.current_tenant.name}</span>
              </>
            )}
          </Space>
          {user ? (
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Space style={{ cursor: 'pointer', paddingRight: 16 }}>
                <Avatar src={user.avatar_url} icon={<UserOutlined />} size="small" />
                <span>{user.github_login}</span>
              </Space>
            </Dropdown>
          ) : (
            <Link to="/login" style={{ paddingRight: 16 }}>登录</Link>
          )}
        </Header>

        <Content style={{ margin: '24px 16px 0', overflow: 'initial' }}>
          <div style={{ padding: 24, background: '#fff', minHeight: 360 }}>
            <Routes>
              <Route path="/" element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
              <Route path="/skills" element={<PrivateRoute><SkillsListPage /></PrivateRoute>} />
              <Route path="/skills/create" element={<PrivateRoute><CreateSkillPage /></PrivateRoute>} />
              <Route path="/agents" element={<PrivateRoute><AgentsListPage /></PrivateRoute>} />
              <Route path="/agents/create" element={<PrivateRoute><CreateAgentPage /></PrivateRoute>} />
              <Route path="/chat" element={<PrivateRoute><AgentChatPage /></PrivateRoute>} />
              <Route path="/memory" element={<PrivateRoute><MemoryPage /></PrivateRoute>} />
              <Route path="/history" element={<PrivateRoute><ExecutionHistoryPage /></PrivateRoute>} />
              <Route path="/tenant/members" element={<PrivateRoute><MembersPage /></PrivateRoute>} />
              <Route path="/tenant/settings" element={<PrivateRoute><SettingsPage /></PrivateRoute>} />
              <Route path="/admin/tenants" element={<PrivateRoute requiredRole="global_admin"><TenantsListPage /></PrivateRoute>} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/auth/callback" element={<CallbackPage />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
            </Routes>
          </div>
        </Content>
      </Layout>
    </Layout>
  );
};

const App = () => (
  <AuthProvider>
    <AppInner />
  </AuthProvider>
);

export default App;
