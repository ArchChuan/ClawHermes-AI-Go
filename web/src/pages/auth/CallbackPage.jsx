import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spin, Alert } from 'antd';
import { getMe } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const CallbackPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();
  const [error, setError] = useState(null);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const res = await getMe();
        const { user, access_token } = res.data;
        login(user, access_token);
        const isNew = searchParams.get('is_new') === 'true';
        navigate(isNew ? '/onboarding' : '/', { replace: true });
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
