import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Table, Typography, Tag, Skeleton, message } from 'antd';
import {
  AppstoreOutlined, RobotOutlined, ApiOutlined, ThunderboltOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import { getAllSkills, getAllAgents, getAgentExecutions, getKnowledgeWorkspaces } from '../services/api';
import api from '../services/api';

const { Title, Text } = Typography;

const statusColors = { success: 'success', error: 'error' };
const statusLabels = { success: '成功', error: '失败' };

const formatDuration = (ms) => {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const execColumns = [
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
    width: 70,
    render: (s) => <Tag color={statusColors[s] || 'default'}>{statusLabels[s] || s}</Tag>,
  },
  {
    title: '输入',
    dataIndex: 'input_preview',
    key: 'input_preview',
    ellipsis: true,
    render: (v) => <Text type="secondary" ellipsis>{v || '-'}</Text>,
  },
  {
    title: '输出',
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
    width: 80,
    align: 'right',
    render: (v) => v ? <Text>{v.toLocaleString()}</Text> : '-',
  },
  {
    title: '耗时',
    dataIndex: 'duration_ms',
    key: 'duration_ms',
    width: 80,
    align: 'right',
    render: (v) => <Text>{formatDuration(v)}</Text>,
  },
  {
    title: '时间',
    dataIndex: 'created_at',
    key: 'created_at',
    width: 150,
    render: (d) => <Text type="secondary">{new Date(d).toLocaleString('zh-CN')}</Text>,
  },
];

const StatCard = ({ loading, title, value, icon, color, bg }) => (
  <Card
    style={{
      borderRadius: 12,
      border: 'none',
      background: bg,
      overflow: 'hidden',
    }}
    styles={{ body: { padding: '20px 24px' } }}
    loading={false}
  >
    {loading ? (
      <Skeleton active paragraph={false} title={{ width: '60%' }} />
    ) : (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ color: color, fontSize: 13, fontWeight: 500, marginBottom: 6, opacity: 0.8 }}>{title}</div>
          <div style={{ color: color, fontSize: 32, fontWeight: 700, lineHeight: 1 }}>{value}</div>
        </div>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: `${color}22`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, color,
        }}>
          {icon}
        </div>
      </div>
    )}
  </Card>
);

const DashboardPage = () => {
  const [counts, setCounts] = useState({ skills: 0, agents: 0, mcpServers: 0, executions: 0, knowledge: 0 });
  const [recentExecs, setRecentExecs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [skillsRes, agentsRes, execsRes, mcpRes, knowledgeRes] = await Promise.allSettled([
          getAllSkills(),
          getAllAgents(),
          getAgentExecutions(),
          api.get('/api/v1/mcp/servers'),
          getKnowledgeWorkspaces(),
        ]);
        if (cancelled) return;

        const skills = skillsRes.status === 'fulfilled' ? (skillsRes.value.data || []) : [];
        const agents = agentsRes.status === 'fulfilled' ? (agentsRes.value.data?.agents || []) : [];
        const execs = execsRes.status === 'fulfilled' ? (execsRes.value.data?.executions || []) : [];
        const mcpServers = mcpRes.status === 'fulfilled' ? (mcpRes.value.data?.servers || []) : [];
        const workspaces = knowledgeRes.status === 'fulfilled'
          ? (knowledgeRes.value.data?.workspaces || knowledgeRes.value.data || []) : [];

        setCounts({ skills: skills.length, agents: agents.length, mcpServers: mcpServers.length, executions: execs.length, knowledge: workspaces.length });
        setRecentExecs(execs.slice(0, 8));
      } catch {
        if (!cancelled) message.error('加载仪表盘数据失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const statCards = [
    { title: 'Agent', value: counts.agents, icon: <RobotOutlined />, color: '#1677ff', bg: '#e6f4ff' },
    { title: '技能', value: counts.skills, icon: <AppstoreOutlined />, color: '#52c41a', bg: '#f6ffed' },
    { title: '知识库', value: counts.knowledge, icon: <DatabaseOutlined />, color: '#13c2c2', bg: '#e6fffb' },
    { title: 'MCP 服务器', value: counts.mcpServers, icon: <ApiOutlined />, color: '#722ed1', bg: '#f9f0ff' },
    { title: '近期执行', value: counts.executions, icon: <ThunderboltOutlined />, color: '#fa8c16', bg: '#fff7e6' },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={4} style={{ margin: 0 }}>概览</Title>
        <Text type="secondary" style={{ fontSize: 13 }}>系统运行状态一览</Text>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {statCards.map((s) => (
          <Col xs={24} sm={12} lg={8} xl={4} key={s.title} style={{ flex: '1 1 0' }}>
            <StatCard {...s} loading={loading} />
          </Col>
        ))}
      </Row>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <Title level={5} style={{ margin: 0 }}>最近执行记录</Title>
        </div>
        <Card
          style={{ borderRadius: 12, border: '1px solid #f0f0f0' }}
          styles={{ body: { padding: 0 } }}
        >
          <Table
            dataSource={recentExecs}
            columns={execColumns}
            rowKey="id"
            loading={loading}
            pagination={false}
            locale={{ emptyText: '暂无执行记录' }}
            size="small"
            style={{ borderRadius: 12, overflow: 'hidden' }}
          />
        </Card>
      </div>
    </div>
  );
};

export default DashboardPage;
