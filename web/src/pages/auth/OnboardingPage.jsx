import React, { useState } from 'react';
import { Tabs, Form, Input, Button, Card, Typography, message, Space } from 'antd';
import { useNavigate } from 'react-router-dom';
import { createTenant, joinTenant, getMe } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const { Title, Text } = Typography;

const OnboardingPage = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [createLoading, setCreateLoading] = useState(false);
  const [joinLoading, setJoinLoading] = useState(false);

  const refreshAndRedirect = async () => {
    const res = await getMe();
    login(res.data.user, res.data.access_token);
    navigate('/', { replace: true });
  };

  const handleCreate = async (values) => {
    setCreateLoading(true);
    try {
      await createTenant({ name: values.name, slug: values.slug });
      message.success('租户创建成功！');
      await refreshAndRedirect();
    } catch (err) {
      message.error(err.response?.data?.message || '创建失败');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleJoin = async (values) => {
    setJoinLoading(true);
    try {
      await joinTenant(values.invite_code);
      message.success('加入成功！');
      await refreshAndRedirect();
    } catch (err) {
      message.error(err.response?.data?.message || '加入失败，邀请码无效或已过期');
    } finally {
      setJoinLoading(false);
    }
  };

  const tabItems = [
    {
      key: 'create',
      label: '创建新租户',
      children: (
        <Form layout="vertical" onFinish={handleCreate}>
          <Form.Item label="租户名称" name="name" rules={[{ required: true, message: '请输入租户名称' }]}>
            <Input placeholder="例如：我的团队" maxLength={64} />
          </Form.Item>
          <Form.Item label="Slug（URL 标识）" name="slug" rules={[
            { required: true, message: '请输入 slug' },
            { pattern: /^[a-z0-9-]+$/, message: '只允许小写字母、数字和连字符' },
          ]}>
            <Input placeholder="例如：my-team" maxLength={32} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={createLoading}>创建租户</Button>
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'join',
      label: '加入已有租户',
      children: (
        <Form layout="vertical" onFinish={handleJoin}>
          <Form.Item label="邀请码" name="invite_code" rules={[{ required: true, message: '请输入邀请码' }]}>
            <Input placeholder="粘贴管理员给您的邀请码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={joinLoading}>加入租户</Button>
          </Form.Item>
        </Form>
      ),
    },
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5' }}>
      <Card style={{ width: 440, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Title level={3} style={{ marginBottom: 4 }}>欢迎使用 ClawHermes</Title>
            <Text type="secondary">创建您的租户空间，或加入已有团队</Text>
          </div>
          <Tabs defaultActiveKey="create" items={tabItems} />
        </Space>
      </Card>
    </div>
  );
};

export default OnboardingPage;
