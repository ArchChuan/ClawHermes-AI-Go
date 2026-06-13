import React, { useState, useEffect, useCallback } from 'react';
import { Table, Card, Typography, Tag, Button, Space, message } from 'antd';
import { ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { getAgentExecutions } from '../services/api';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../constants';

const { Title, Text } = Typography;

const formatDuration = (ms) => {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const columns = [
  {
    title: 'Agent',
    dataIndex: 'agent_name',
    key: 'agent_name',
    width: 140,
    ellipsis: true,
    render: (v) => <Text strong>{v}</Text>,
  },
  {
    title: '状态',
    dataIndex: 'status',
    key: 'status',
    width: 88,
    filters: [
      { text: '成功', value: 'success' },
      { text: '失败', value: 'error' },
    ],
    onFilter: (value, record) => record.status === value,
    render: (s) => s === 'success'
      ? <Tag icon={<CheckCircleOutlined />} color="success">成功</Tag>
      : <Tag icon={<CloseCircleOutlined />} color="error">失败</Tag>,
  },
  {
    title: '输入预览',
    dataIndex: 'input_preview',
    key: 'input_preview',
    ellipsis: true,
    render: (v) => <Text type="secondary" ellipsis>{v || '-'}</Text>,
  },
  {
    title: '输出预览',
    dataIndex: 'output_preview',
    key: 'output_preview',
    ellipsis: true,
    render: (text, record) =>
      record.status === 'error'
        ? <Text type="danger" ellipsis>{record.error_message || '执行失败'}</Text>
        : <Text ellipsis>{text || '-'}</Text>,
  },
  {
    title: 'Token',
    dataIndex: 'total_tokens',
    key: 'total_tokens',
    width: 90,
    align: 'right',
    sorter: (a, b) => (a.total_tokens || 0) - (b.total_tokens || 0),
    render: (v) => v ? v.toLocaleString() : '-',
  },
  {
    title: '耗时',
    dataIndex: 'duration_ms',
    key: 'duration_ms',
    width: 90,
    align: 'right',
    sorter: (a, b) => (a.duration_ms || 0) - (b.duration_ms || 0),
    render: (v) => formatDuration(v),
  },
  {
    title: '时间',
    dataIndex: 'created_at',
    key: 'created_at',
    width: 160,
    sorter: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    defaultSortOrder: 'descend',
    render: (d) => <Text type="secondary">{new Date(d).toLocaleString('zh-CN')}</Text>,
  },
];

const ExecutionHistoryPage = () => {
  const [executions, setExecutions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0 });

  const fetchPage = useCallback(async (page, pageSize) => {
    setLoading(true);
    try {
      const res = await getAgentExecutions(page, pageSize);
      setExecutions(res.data.executions || []);
      setPagination({ current: page, pageSize, total: res.data.total || 0 });
    } catch (err) {
      message.error(err.response?.data?.error || '加载执行历史失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getAgentExecutions(1, 20);
        if (!cancelled) {
          setExecutions(res.data.executions || []);
          setPagination({ current: 1, pageSize: DEFAULT_PAGE_SIZE, total: res.data.total || 0 });
        }
      } catch (err) {
        if (!cancelled) message.error(err.response?.data?.error || '加载执行历史失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>执行历史</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>近期所有 Agent 执行记录</Text>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => fetchPage(1, pagination.pageSize)}
          loading={loading}
        >
          刷新
        </Button>
      </div>

      <Card style={{ borderRadius: 12, border: '1px solid #f0f0f0' }} styles={{ body: { padding: 0 } }}>
        <Table
          dataSource={executions}
          columns={columns}
          rowKey="id"
          loading={loading}
          locale={{ emptyText: '暂无执行记录' }}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showQuickJumper: true,
            showTotal: (total) => `共 ${total} 条`,
            style: { padding: '12px 16px' },
          }}
          onChange={(pag) => fetchPage(pag.current, pag.pageSize)}
          style={{ borderRadius: 12, overflow: 'hidden' }}
        />
      </Card>
    </div>
  );
};

export default ExecutionHistoryPage;
