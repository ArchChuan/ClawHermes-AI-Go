import React, { useState, useEffect } from 'react';
import {
  Card, Table, Button, Input, Modal, Space, Tag, Select, message,
  Popconfirm, Tabs, Empty, Descriptions, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, SearchOutlined, PlusOutlined, UserOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  addMemory, searchMemory, getMemoryStats, clearSession,
  getMemoryEntities, getMemorySummary, deleteMemory,
} from '../services/api';
import { COMPACT_PAGE_SIZE, MEMORY_SEARCH_LIMIT } from '../constants';

const { Search, TextArea } = Input;
const { Title, Text } = Typography;

const importanceColor = (v) => v > 0.7 ? '#f5222d' : v > 0.5 ? '#fa8c16' : '#52c41a';

const memoryColumns = (onDelete) => [
  {
    title: '类型',
    dataIndex: 'type',
    key: 'type',
    width: 80,
    render: (type) => (
      <Tag color={type === 'user' ? 'blue' : type === 'assistant' ? 'green' : 'default'}>
        {type === 'user' ? '用户' : type === 'assistant' ? '助手' : '系统'}
      </Tag>
    ),
  },
  {
    title: '内容',
    dataIndex: 'content',
    key: 'content',
    ellipsis: true,
    render: (content) => (
      <Tooltip title={content} placement="topLeft">
        <Text ellipsis>{content}</Text>
      </Tooltip>
    ),
  },
  {
    title: '标签',
    dataIndex: 'tags',
    key: 'tags',
    width: 160,
    render: (tags) => tags?.map(tag => <Tag key={tag} style={{ marginBottom: 2 }}>{tag}</Tag>),
  },
  {
    title: '重要性',
    dataIndex: 'importance',
    key: 'importance',
    width: 80,
    align: 'right',
    sorter: (a, b) => (a.importance || 0) - (b.importance || 0),
    render: (v) => <Text style={{ color: importanceColor(v), fontWeight: 600 }}>{v?.toFixed(2) ?? '-'}</Text>,
  },
  {
    title: '时间',
    dataIndex: 'timestamp',
    key: 'timestamp',
    width: 150,
    render: (ts) => <Text type="secondary">{new Date(ts).toLocaleString('zh-CN')}</Text>,
  },
  {
    title: '操作',
    key: 'action',
    width: 80,
    render: (_, record) => (
      <Popconfirm title="确定删除这条记忆？" onConfirm={() => onDelete(record.id)} okText="删除" cancelText="取消">
        <Button danger size="small" icon={<DeleteOutlined />} type="text" />
      </Popconfirm>
    ),
  },
];

const entityColumns = [
  { title: '名称', dataIndex: 'name', key: 'name', render: (v) => <Text strong>{v}</Text> },
  { title: '类型', dataIndex: 'type', key: 'type', width: 100, render: (v) => <Tag>{v}</Tag> },
  {
    title: '置信度', dataIndex: 'confidence', key: 'confidence', width: 90, align: 'right',
    render: (v) => <Text>{(v * 100).toFixed(1)}%</Text>,
  },
  {
    title: '首次出现', dataIndex: 'first_seen', key: 'first_seen', width: 150,
    render: (d) => <Text type="secondary">{new Date(d).toLocaleString('zh-CN')}</Text>,
  },
  {
    title: '最近出现', dataIndex: 'last_seen', key: 'last_seen', width: 150,
    render: (d) => <Text type="secondary">{new Date(d).toLocaleString('zh-CN')}</Text>,
  },
];

const MemoryPage = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [entities, setEntities] = useState([]);
  const [summary, setSummary] = useState('');
  const [sessionIdInput, setSessionIdInput] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newMemory, setNewMemory] = useState({ role: 'user', content: '', tags: [], importance: 0.5 });

  const loadStats = async () => {
    try {
      const res = await getMemoryStats();
      if (res.data) setStats(res.data);
    } catch {
      message.error('加载记忆统计失败');
    }
  };

  const handleSearch = async (query) => {
    const q = (query ?? searchQuery).trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await searchMemory({ query: q, limit: MEMORY_SEARCH_LIMIT });
      setSearchResults(res.data?.results || []);
    } catch {
      message.error('搜索记忆失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAddMemory = async () => {
    if (!newMemory.content.trim()) { message.warning('请输入记忆内容'); return; }
    try {
      await addMemory({ ...newMemory, session_id: 'default', user_id: 'default' });
      message.success('记忆添加成功');
      setCreateOpen(false);
      setNewMemory({ role: 'user', content: '', tags: [], importance: 0.5 });
      loadStats();
      if (searchQuery.trim()) handleSearch(searchQuery);
    } catch {
      message.error('添加记忆失败');
    }
  };

  const handleDeleteMemory = async (id) => {
    try {
      await deleteMemory(id);
      message.success('删除成功');
      setSearchResults(prev => prev.filter(r => r.entry?.id !== id));
      loadStats();
    } catch {
      message.error('删除记忆失败');
    }
  };

  const loadEntities = async () => {
    try {
      const res = await getMemoryEntities({ tenant_id: 'default', user_id: 'default' });
      setEntities(res.data?.entities || []);
    } catch {
      message.error('加载实体失败');
    }
  };

  const loadSummary = async () => {
    if (!sessionIdInput.trim()) { message.warning('请输入会话 ID'); return; }
    try {
      const res = await getMemorySummary(sessionIdInput, { tenant_id: 'default', user_id: 'default' });
      setSummary(res.data?.summary || '');
    } catch {
      message.error('加载摘要失败');
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const tabItems = [
    {
      key: 'search',
      label: '记忆搜索',
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Search
            placeholder="输入关键词搜索记忆..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onSearch={handleSearch}
            enterButton={<><SearchOutlined /> 搜索</>}
            allowClear
            loading={loading}
          />
          {searchResults.length > 0 ? (
            <Table
              columns={memoryColumns(handleDeleteMemory)}
              dataSource={searchResults.map(r => ({ ...r.entry, key: r.entry?.id }))}
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: COMPACT_PAGE_SIZE, showTotal: (t) => `共 ${t} 条` }}
              size="small"
            />
          ) : (
            <Empty description={searchQuery ? '没有找到相关记忆' : '输入关键词搜索记忆'} style={{ padding: '40px 0' }} />
          )}
        </Space>
      ),
    },
    {
      key: 'stats',
      label: '统计',
      children: stats ? (
        <Descriptions bordered column={2} size="small">
          <Descriptions.Item label="总记忆数">{stats.total_entries}</Descriptions.Item>
          <Descriptions.Item label="短期记忆">{stats.short_term_count}</Descriptions.Item>
          <Descriptions.Item label="长期记忆">{stats.long_term_count}</Descriptions.Item>
          <Descriptions.Item label="实体数">{stats.entity_count}</Descriptions.Item>
          <Descriptions.Item label="会话数">{stats.sessions_count}</Descriptions.Item>
          <Descriptions.Item label="活跃用户">{stats.active_users}</Descriptions.Item>
          <Descriptions.Item label="向量数">{stats.vector_count}</Descriptions.Item>
          <Descriptions.Item label="最后访问">{stats.last_access_time ? new Date(stats.last_access_time).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
        </Descriptions>
      ) : (
        <Empty description="暂无统计数据" />
      ),
    },
    {
      key: 'entities',
      label: '实体',
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Button icon={<ReloadOutlined />} onClick={loadEntities}>加载实体</Button>
          <Table
            columns={entityColumns}
            dataSource={entities}
            rowKey="id"
            pagination={{ pageSize: COMPACT_PAGE_SIZE }}
            size="small"
            locale={{ emptyText: '点击"加载实体"查看' }}
          />
        </Space>
      ),
    },
    {
      key: 'summary',
      label: '会话摘要',
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space>
            <Input
              placeholder="输入会话 ID"
              value={sessionIdInput}
              onChange={(e) => setSessionIdInput(e.target.value)}
              onPressEnter={loadSummary}
              style={{ width: 240 }}
            />
            <Button type="primary" onClick={loadSummary}>查看摘要</Button>
          </Space>
          {summary ? (
            <Card style={{ background: '#fafafa', borderRadius: 8 }}>
              <Text style={{ lineHeight: 1.8 }}>{summary}</Text>
            </Card>
          ) : (
            <Empty description="输入会话 ID 查看摘要" style={{ padding: '40px 0' }} />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>记忆管理</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>搜索、查看和管理 Agent 记忆</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          添加记忆
        </Button>
      </div>

      <Card style={{ borderRadius: 12, border: '1px solid #f0f0f0' }}>
        <Tabs items={tabItems} />
      </Card>

      <Modal
        title="添加记忆"
        open={createOpen}
        onOk={handleAddMemory}
        onCancel={() => { setCreateOpen(false); setNewMemory({ role: 'user', content: '', tags: [], importance: 0.5 }); }}
        okText="添加"
        cancelText="取消"
        width={520}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>角色</div>
            <Select
              value={newMemory.role}
              onChange={(v) => setNewMemory({ ...newMemory, role: v })}
              style={{ width: '100%' }}
              options={[
                { value: 'user', label: '用户' },
                { value: 'assistant', label: '助手' },
                { value: 'system', label: '系统' },
              ]}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>内容</div>
            <TextArea
              rows={4}
              value={newMemory.content}
              onChange={(e) => setNewMemory({ ...newMemory, content: e.target.value })}
              placeholder="输入记忆内容..."
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>重要性：<Text type="secondary">{newMemory.importance.toFixed(2)}</Text></div>
            <input
              type="range" min="0" max="1" step="0.1"
              value={newMemory.importance}
              onChange={(e) => setNewMemory({ ...newMemory, importance: parseFloat(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
};

export default MemoryPage;
