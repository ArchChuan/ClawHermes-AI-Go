import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Input,
  Modal,
  Space,
  Tag,
  Select,
  message,
  Popconfirm,
  Row,
  Col,
  Tabs,
  Empty,
  Descriptions,
  Tooltip
} from 'antd';
import {
  DeleteOutlined,
  SearchOutlined,
  PlusOutlined,
  EyeOutlined,
  DatabaseOutlined,
  SettingOutlined,
  UserOutlined,
  FileTextOutlined
} from '@ant-design/icons';
import {
  searchMemory,
  getMemoryStats,
  clearSession,
  getMemoryEntities,
  getMemorySummary,
  deleteMemory
} from '../services/api';

const { Search } = Input;
const { TextArea } = Input;

const MemoryPage = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [activeTab, setActiveTab] = useState('memory');
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [entities, setEntities] = useState([]);
  const [summary, setSummary] = useState('');
  const [newMemory, setNewMemory] = useState({
    role: 'user',
    content: '',
    tags: [],
    importance: 0.5
  });

  // 加载记忆统计
  const loadStats = async () => {
    try {
      const response = await getMemoryStats();
      if (response.data) {
        setStats(response.data);
      }
    } catch (error) {
      message.error('加载记忆统计失败');
    }
  };

  // 搜索记忆
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      return;
    }
    setLoading(true);
    try {
      const response = await searchMemory({
        query: searchQuery,
        limit: 20
      });
      if (response.data && response.data.results) {
        setSearchResults(response.data.results);
      }
    } catch (error) {
      message.error('搜索记忆失败');
    } finally {
      setLoading(false);
    }
  };

  // 添加记忆
  const handleAddMemory = async () => {
    if (!newMemory.content.trim()) {
      message.warning('请输入记忆内容');
      return;
    }
    try {
      const response = await addMemory({
        ...newMemory,
        session_id: selectedSession?.session_id || 'default',
        tenant_id: 'default',
        user_id: 'default'
      });
      if (response.data) {
        message.success('记忆添加成功');
        setCreateModalVisible(false);
        setNewMemory({ role: 'user', content: '', tags: [], importance: 0.5 });
        handleSearch();
      }
    } catch (error) {
      message.error('添加记忆失败');
    }
  };

  // 删除记忆
  const handleDeleteMemory = async (id) => {
    try {
      await deleteMemory(id);
      message.success('记忆删除成功');
      handleSearch();
      loadStats();
    } catch (error) {
      message.error('删除记忆失败');
    }
  };

  // 清除会话
  const handleClearSession = async (sessionId) => {
    try {
      await clearSession(sessionId, { tenant_id: 'default', user_id: 'default' });
      message.success('会话清除成功');
      loadStats();
    } catch (error) {
      message.error('清除会话失败');
    }
  };

  // 加载实体
  const loadEntities = async () => {
    try {
      const response = await getMemoryEntities({ tenant_id: 'default', user_id: 'default' });
      if (response.data && response.data.entities) {
        setEntities(response.data.entities);
      }
    } catch (error) {
      message.error('加载实体失败');
    }
  };

  // 加载摘要
  const loadSummary = async (sessionId) => {
    try {
      const response = await getMemorySummary(sessionId, { tenant_id: 'default', user_id: 'default' });
      if (response.data) {
        setSummary(response.data.summary);
      }
    } catch (error) {
      message.error('加载摘要失败');
    }
  };

  useEffect(() => {
    loadStats();
    handleSearch();
  }, []);

  const memoryColumns = [
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type) => (
        <Tag color={type === 'user' ? 'blue' : type === 'assistant' ? 'green' : 'default'}>
          {type === 'user' ? '用户' : type === 'assistant' ? '助手' : '系统'}
        </Tag>
      )
    },
    {
      title: '内容',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (content) => (
        <Tooltip title={content}>
          <span>{content}</span>
        </Tooltip>
      )
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      render: (tags) => tags?.map(tag => <Tag key={tag}>{tag}</Tag>)
    },
    {
      title: '重要性',
      dataIndex: 'importance',
      key: 'importance',
      render: (importance) => (
        <span style={{ color: importance > 0.7 ? 'red' : importance > 0.5 ? 'orange' : 'green' }}>
          {importance.toFixed(2)}
        </span>
      )
    },
    {
      title: '时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (timestamp) => new Date(timestamp).toLocaleString('zh-CN')
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Popconfirm
          title="确定要删除这条记忆吗？"
          onConfirm={() => handleDeleteMemory(record.id)}
          okText="确定"
          cancelText="取消"
        >
          <Button danger size="small" icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      )
    }
  ];

  const entityColumns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name'
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type) => <Tag>{type}</Tag>
    },
    {
      title: '置信度',
      dataIndex: 'confidence',
      key: 'confidence',
      render: (confidence) => `${(confidence * 100).toFixed(1)}%`
    },
    {
      title: '首次出现',
      dataIndex: 'first_seen',
      key: 'first_seen',
      render: (date) => new Date(date).toLocaleString('zh-CN')
    },
    {
      title: '最近出现',
      dataIndex: 'last_seen',
      key: 'last_seen',
      render: (date) => new Date(date).toLocaleString('zh-CN')
    }
  ];

  return (
    <div style={{ padding: '24px', background: '#f0f2f5', minHeight: '100vh' }}>
      <Row gutter={16}>
        <Col span={24}>
          <Card
            title={
              <Space>
                <DatabaseOutlined />
                <span>记忆管理</span>
              </Space>
            }
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalVisible(true)}>
                添加记忆
              </Button>
            }
          >
            <Tabs activeKey={activeTab} onChange={setActiveTab}>
              <Tabs.TabPane tab="记忆搜索" key="search">
                <Space direction="vertical" style={{ width: '100%' }} size="large">
                  <Search
                    placeholder="搜索记忆..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onPressEnter={handleSearch}
                    onSearch={handleSearch}
                    style={{ width: '100%' }}
                    loading={loading}
                    enterButton
                    allowClear
                  />
                  <Button type="primary" onClick={handleSearch} icon={<SearchOutlined />}>
                    搜索
                  </Button>
                </Space>

                {searchResults.length > 0 ? (
                  <Table
                    columns={memoryColumns}
                    dataSource={searchResults.map(r => ({ ...r.entry, id: r.entry.id, key: r.entry.id }))}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 10 }}
                  />
                ) : (
                  <Empty description={searchQuery ? '没有找到相关记忆' : '输入关键词搜索记忆'} />
                )}
              </Tabs.TabPane>

              <Tabs.TabPane tab="记忆统计" key="stats">
                {stats && (
                  <Descriptions bordered column={2}>
                    <Descriptions.Item label="总记忆数">{stats.total_entries}</Descriptions.Item>
                    <Descriptions.Item label="短期记忆">{stats.short_term_count}</Descriptions.Item>
                    <Descriptions.Item label="长期记忆">{stats.long_term_count}</Descriptions.Item>
                    <Descriptions.Item label="实体数">{stats.entity_count}</Descriptions.Item>
                    <Descriptions.Item label="会话数">{stats.sessions_count}</Descriptions.Item>
                    <Descriptions.Item label="活跃用户">{stats.active_users}</Descriptions.Item>
                    <Descriptions.Item label="向量数">{stats.vector_count}</Descriptions.Item>
                    <Descriptions.Item label="最后访问">
                      {new Date(stats.last_access_time).toLocaleString('zh-CN')}
                    </Descriptions.Item>
                  </Descriptions>
                )}
              </Tabs.TabPane>

              <Tabs.TabPane tab="实体管理" key="entities">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Button icon={<UserOutlined />} onClick={loadEntities}>
                    刷新实体
                  </Button>
                  <Table
                    columns={entityColumns}
                    dataSource={entities}
                    rowKey="id"
                    pagination={{ pageSize: 10 }}
                  />
                </Space>
              </Tabs.TabPane>

              <Tabs.TabPane tab="会话摘要" key="summary">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input
                    placeholder="输入会话 ID"
                    onChange={(e) => setSelectedSession({ session_id: e.target.value })}
                    onPressEnter={(e) => loadSummary(e.target.value)}
                  />
                  <Card title="会话摘要">
                    {summary ? (
                      <p style={{ lineHeight: 1.6 }}>{summary}</p>
                    ) : (
                      <Empty description="选择会话查看摘要" />
                    )}
                  </Card>
                </Space>
              </Tabs.TabPane>
            </Tabs>
          </Card>
        </Col>
      </Row>

      <Modal
        title="添加记忆"
        open={createModalVisible}
        onOk={handleAddMemory}
        onCancel={() => setCreateModalVisible(false)}
        width={600}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <label>角色：</label>
            <Select
              value={newMemory.role}
              onChange={(value) => setNewMemory({ ...newMemory, role: value })}
              style={{ width: '100%' }}
            >
              <Select.Option value="user">用户</Select.Option>
              <Select.Option value="assistant">助手</Select.Option>
              <Select.Option value="system">系统</Select.Option>
            </Select>
          </div>
          <div>
            <label>内容：</label>
            <TextArea
              rows={4}
              value={newMemory.content}
              onChange={(e) => setNewMemory({ ...newMemory, content: e.target.value })}
              placeholder="输入记忆内容..."
            />
          </div>
          <div>
            <label>重要性 ({newMemory.importance.toFixed(2)})</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
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
