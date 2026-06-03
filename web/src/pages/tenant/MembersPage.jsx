import React, { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Avatar, Tag, Space, Typography, Popconfirm, message } from 'antd';
import { UserAddOutlined } from '@ant-design/icons';
import { getTenantMembers, inviteMember, removeMember } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const { Title } = Typography;

const MembersPage = () => {
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [form] = Form.useForm();
  const isAdmin = user?.role === 'admin';

  const fetchMembers = async () => {
    setLoading(true);
    try {
      const res = await getTenantMembers();
      setMembers(res.data.members || []);
    } catch {
      message.error('获取成员列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMembers(); }, []);

  const handleInvite = async (values) => {
    setInviteLoading(true);
    try {
      await inviteMember(values);
      message.success('邀请已发送');
      setInviteOpen(false);
      form.resetFields();
      fetchMembers();
    } catch (err) {
      message.error(err.response?.data?.message || '邀请失败');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRemove = async (userId) => {
    try {
      await removeMember(userId);
      message.success('成员已移除');
      fetchMembers();
    } catch (err) {
      message.error(err.response?.data?.message || '移除失败');
    }
  };

  const columns = [
    {
      title: '用户', dataIndex: 'github_login',
      render: (login, record) => (
        <Space>
          <Avatar src={record.avatar_url} size="small">{login?.[0]?.toUpperCase()}</Avatar>
          {login}
        </Space>
      ),
    },
    {
      title: '角色', dataIndex: 'role',
      render: (role) => <Tag color={role === 'admin' ? 'blue' : 'default'}>{role === 'admin' ? '管理员' : '成员'}</Tag>,
    },
    {
      title: '加入时间', dataIndex: 'joined_at',
      render: (v) => v ? new Date(v).toLocaleDateString('zh-CN') : '-',
    },
    ...(isAdmin ? [{
      title: '操作', key: 'action',
      render: (_, record) => record.id !== user?.id ? (
        <Popconfirm title="确认移除该成员？" onConfirm={() => handleRemove(record.id)} okText="确认" cancelText="取消">
          <Button danger size="small">移除</Button>
        </Popconfirm>
      ) : <Tag>（您）</Tag>,
    }] : []),
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>成员管理</Title>
        {isAdmin && <Button type="primary" icon={<UserAddOutlined />} onClick={() => setInviteOpen(true)}>邀请成员</Button>}
      </div>
      <Table dataSource={members} columns={columns} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} />
      <Modal title="邀请成员" open={inviteOpen} onCancel={() => { setInviteOpen(false); form.resetFields(); }} footer={null}>
        <Form form={form} layout="vertical" onFinish={handleInvite}>
          <Form.Item label="GitHub 用户名" name="github_login" rules={[{ required: true, message: '请输入 GitHub 用户名' }]}>
            <Input placeholder="例如：octocat" />
          </Form.Item>
          <Form.Item label="角色" name="role" initialValue="member">
            <Select options={[{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={inviteLoading}>发送邀请</Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default MembersPage;
