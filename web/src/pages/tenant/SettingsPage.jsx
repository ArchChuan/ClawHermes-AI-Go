import React, { useState } from 'react';
import { Form, Input, Button, Typography, message, Card } from 'antd';
import { updateTenant } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const { Title } = Typography;

const SettingsPage = () => {
  const { user, login, accessToken } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleSave = async (values) => {
    setLoading(true);
    try {
      await updateTenant(values);
      message.success('设置已保存');
      login({ ...user, current_tenant: { ...user.current_tenant, ...values } }, accessToken);
    } catch (err) {
      message.error(err.response?.data?.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Title level={4} style={{ marginBottom: 24 }}>租户设置</Title>
      <Card style={{ maxWidth: 480 }}>
        <Form
          layout="vertical"
          initialValues={{
            name: user?.current_tenant?.name || '',
            avatar_url: user?.current_tenant?.avatar_url || '',
          }}
          onFinish={handleSave}
        >
          <Form.Item label="租户名称" name="name" rules={[{ required: true, message: '请输入租户名称' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="头像 URL" name="avatar_url">
            <Input placeholder="https://example.com/avatar.png" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>保存</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default SettingsPage;
