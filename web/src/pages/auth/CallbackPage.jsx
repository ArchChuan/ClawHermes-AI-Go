import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spin, Alert } from 'antd';
import api from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const CallbackPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();
  const [error, setError] = useState(null);

  const handledRef = React.useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    const handleCallback = async () => {
      try {
        const onboardingToken = searchParams.get('onboarding_token');
        if (onboardingToken) {
          sessionStorage.setItem('onboarding_token', onboardingToken);
          const githubLogin = searchParams.get('github_login') || '';
          const avatarUrl = searchParams.get('avatar_url') || '';
          sessionStorage.setItem('github_login', githubLogin);
          sessionStorage.setItem('avatar_url', avatarUrl);
          navigate('/onboarding', { replace: true });
          return;
        }

        const accessToken = searchParams.get('access_token');
        if (accessToken) {
          localStorage.setItem('access_token', accessToken);
          const meRes = await api.get('/auth/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
            _retry: true,
          });
          login(
            {
              sub: meRes.data.sub,
              tenant_id: meRes.data.tenant_id,
              role: meRes.data.role,
              global_role: meRes.data.global_role,
              current_tenant: meRes.data.tenant_id ? { id: meRes.data.tenant_id } : null,
              avatar_url: meRes.data.avatar_url || '',
              github_login: meRes.data.github_login || '',
            },
            accessToken,
          );
          navigate('/', { replace: true });
          return;
        }

        setError('登录回调参数缺失，请重新登录');
      } catch (err) {
        setError(err.response?.data?.message || '登录失败，请重试');
      }
    };
    handleCallback();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Alert type="error" message={error} description={<a href="/login">返回登录</a>} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin size="large" tip="正在完成登录..." />
    </div>
  );
};

export default CallbackPage;
