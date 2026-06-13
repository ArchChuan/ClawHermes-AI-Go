import React, { useEffect, useState } from 'react';
import { Table, Button, Tag, Typography, Popconfirm, message, Card } from 'antd';
import { getAllTenants, setTenantEnabled } from '../../services/api';
import { DEFAULT_PAGE_SIZE } from '../../constants';

const { Title, Text } = Typography;

const TenantsListPage = () => {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const res = await getAllTenants();
      setTenants(res.data.tenants || []);
    } catch {
      message.error('获取租户列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTenants(); }, []);

  const handleToggle = async (tenantId, currentStatus) => {
    const enabling = currentStatus !== 'active';
    try {
      await setTenantEnabled(tenantId, enabling);
      message.success(enabling ? '已启用' : '已禁用');
      fetchTenants();
    } catch (err) {
      message.error(err.response?.data?.message || '操作失败');
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    {
      title: '租户名称', dataIndex: 'name',
      render: (name) => <Text strong>{name}</Text>,
    },
    { title: 'Slug', dataIndex: 'slug', render: (v) => <Text type="secondary" style={{ fontFamily: 'monospace' }}>{v}</Text> },
    { title: '成员数', dataIndex: 'member_count', render: (v) => v ?? '-' },
    {
      title: '状态', dataIndex: 'status',
      render: (status) => (
        <Tag
          color={status === 'active' ? 'green' : 'red'}
          style={{ borderRadius: 6 }}
        >
          {status === 'active' ? '启用' : '禁用'}
        </Tag>
      ),
    },
    {
      title: '操作', key: 'action',
      render: (_, record) => (
        <Popconfirm
          title={`确认${record.status === 'active' ? '禁用' : '启用'}该租户？`}
          onConfirm={() => handleToggle(record.id, record.status)}
          okText="确认" cancelText="取消"
        >
          <Button size="small" danger={record.status === 'active'}>
            {record.status === 'active' ? '禁用' : '启用'}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <Title level={4} style={{ margin: 0 }}>所有租户</Title>
        <Text type="secondary" style={{ fontSize: 13 }}>查看和管理平台所有租户</Text>
      </div>
      <Card style={{ borderRadius: 12, border: '1px solid #f0f0f0' }} styles={{ body: { padding: 0 } }}>
        <Table
          dataSource={tenants}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: DEFAULT_PAGE_SIZE, showTotal: (t) => `共 ${t} 个租户` }}
          style={{ borderRadius: 12, overflow: 'hidden' }}
        />
      </Card>
    </div>
  );
};

export default TenantsListPage;
