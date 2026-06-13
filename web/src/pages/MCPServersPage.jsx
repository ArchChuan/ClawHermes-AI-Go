import React, { useState, useEffect } from 'react';
import {
  Table, Button, Tag, Badge, Popconfirm, Drawer, Form, Input,
  Select, InputNumber, Space, Descriptions, Tabs, Alert, message, Typography, Card,
} from 'antd';
import { PlusOutlined, ReloadOutlined, ApiOutlined } from '@ant-design/icons';
import {
  getMCPServers, connectMCPServer, disconnectMCPServer,
  getMCPServerTools, getMCPServerResources,
} from '../services/api';
import { COMPACT_PAGE_SIZE, MCP_DEFAULT_TIMEOUT_SEC } from '../constants';

const { Title, Text } = Typography;
const TRANSPORT_COLORS = { stdio: 'blue', sse: 'green', http: 'cyan' };
const STATUS_MAP = { connected: 'success', disconnected: 'default', error: 'error' };
const STATUS_LABELS = { connected: '已连接', disconnected: '未连接', error: '错误' };

function parseArgs(str) {
  return (str || '').split(/\s+/).filter(Boolean);
}

function parseEnv(str) {
  const result = {};
  (str || '').split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1);
  });
  return result;
}

function ConnectDrawer({ open, onClose, onSuccess }) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const transport = Form.useWatch('transport', form);

  const handleFinish = async (values) => {
    setSubmitting(true);
    try {
      const cfg = {
        id: values.id || crypto.randomUUID(),
        name: values.name,
        transport: values.transport,
        command: values.command || '',
        args: parseArgs(values.args),
        env: parseEnv(values.env),
        url: values.url || '',
        timeout: (values.timeout_sec || 30) * 1e9,
      };
      await connectMCPServer(cfg);
      message.success('MCP 服务器连接成功');
      form.resetFields();
      onSuccess();
    } catch (err) {
      if (err.response?.status !== 403) {
        message.error(err.response?.data?.error || '连接失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      title="连接 MCP 服务器"
      width={480}
      open={open}
      onClose={() => { form.resetFields(); onClose(); }}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item label="服务器 ID（留空自动生成）" name="id">
          <Input placeholder="my-server-id" />
        </Form.Item>
        <Form.Item label="服务器名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
          <Input maxLength={64} />
        </Form.Item>
        <Form.Item label="Transport" name="transport" rules={[{ required: true, message: '请选择 Transport' }]}>
          <Select options={[
            { value: 'stdio', label: 'stdio（子进程）' },
            { value: 'sse', label: 'SSE（长连接）' },
            { value: 'http', label: 'HTTP（轮询）' },
          ]} />
        </Form.Item>
        {transport === 'stdio' && (
          <>
            <Form.Item label="命令（command）" name="command" rules={[{ required: true, message: '请输入命令' }]}>
              <Input placeholder="node" />
            </Form.Item>
            <Form.Item label="参数（空格分隔）" name="args">
              <Input placeholder="server.js --port 3000" />
            </Form.Item>
            <Form.Item label="环境变量（每行 KEY=VALUE）" name="env">
              <Input.TextArea rows={4} placeholder="API_KEY=xxx&#10;DEBUG=true" />
            </Form.Item>
          </>
        )}
        {(transport === 'sse' || transport === 'http') && (
          <Form.Item label="URL" name="url" rules={[{ required: true, message: '请输入 URL' }]}>
            <Input placeholder="http://localhost:3000/mcp" />
          </Form.Item>
        )}
        <Form.Item label="超时（秒）" name="timeout_sec" initialValue={MCP_DEFAULT_TIMEOUT_SEC}>
          <InputNumber min={1} max={300} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>连接</Button>
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function ServerDetailDrawer({ server, onClose }) {
  const [tools, setTools] = useState([]);
  const [resources, setResources] = useState([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingRes, setLoadingRes] = useState(false);
  const [toolsError, setToolsError] = useState(null);
  const [resError, setResError] = useState(null);

  useEffect(() => {
    if (!server) return;
    setLoadingTools(true);
    setLoadingRes(true);
    setToolsError(null);
    setResError(null);

    getMCPServerTools(server.id)
      .then((r) => setTools(r.data?.tools || []))
      .catch((e) => setToolsError(e.response?.data?.error || '加载工具失败'))
      .finally(() => setLoadingTools(false));

    getMCPServerResources(server.id)
      .then((r) => setResources(r.data?.resources || []))
      .catch((e) => setResError(e.response?.data?.error || '加载资源失败'))
      .finally(() => setLoadingRes(false));
  }, [server]);

  const toolCols = [
    { title: '名称', dataIndex: 'name', width: 200, render: (v) => <Text strong>{v}</Text> },
    { title: '描述', dataIndex: 'description', ellipsis: true },
  ];
  const resCols = [
    { title: 'URI', dataIndex: 'uri', width: 200, ellipsis: true },
    { title: '名称', dataIndex: 'name' },
    { title: 'MIME', dataIndex: 'mimeType', width: 120 },
  ];

  const tabItems = [
    {
      key: 'tools',
      label: `工具（${tools.length}）`,
      children: toolsError
        ? <Alert type="error" message={toolsError} />
        : <Table size="small" dataSource={tools} columns={toolCols} rowKey="name"
            loading={loadingTools} locale={{ emptyText: '此服务器未暴露任何工具' }}
            pagination={false} />,
    },
    {
      key: 'resources',
      label: `资源（${resources.length}）`,
      children: resError
        ? <Alert type="error" message={resError} />
        : <Table size="small" dataSource={resources} columns={resCols} rowKey="uri"
            loading={loadingRes} locale={{ emptyText: '此服务器未暴露任何资源' }}
            pagination={false} />,
    },
  ];

  return (
    <Drawer
      title={server?.name || '服务器详情'}
      width={640}
      open={!!server}
      onClose={onClose}
      destroyOnClose
    >
      {server && (
        <>
          <Descriptions size="small" column={2} bordered style={{ marginBottom: 20 }}>
            <Descriptions.Item label="ID" span={2}><Text code>{server.id}</Text></Descriptions.Item>
            <Descriptions.Item label="Transport">
              <Tag color={TRANSPORT_COLORS[server.transport]}>{server.transport}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Badge status={STATUS_MAP[server.status] || 'default'} text={STATUS_LABELS[server.status] || server.status} />
            </Descriptions.Item>
            <Descriptions.Item label="版本">{server.version || '-'}</Descriptions.Item>
            <Descriptions.Item label="工具数">{tools.length}</Descriptions.Item>
          </Descriptions>
          <Tabs defaultActiveKey="tools" items={tabItems} />
        </>
      )}
    </Drawer>
  );
}

export default function MCPServersPage() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [detailServer, setDetailServer] = useState(null);

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await getMCPServers();
      setServers(res.data?.servers || []);
    } catch {
      message.error('获取 MCP 服务器列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchServers(); }, []);

  const handleDisconnect = async (id) => {
    try {
      await disconnectMCPServer(id);
      message.success('已断开连接');
      fetchServers();
    } catch (err) {
      if (err.response?.status !== 403) {
        message.error(err.response?.data?.error || '断开失败');
      }
    }
  };

  const columns = [
    {
      title: '名称', dataIndex: 'name', width: 200,
      render: (v) => <Text strong>{v}</Text>,
    },
    {
      title: 'Transport', dataIndex: 'transport', width: 110,
      render: (v) => <Tag color={TRANSPORT_COLORS[v]}>{v}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', width: 110,
      render: (v) => <Badge status={STATUS_MAP[v] || 'default'} text={STATUS_LABELS[v] || v} />,
    },
    {
      title: '工具', width: 80, align: 'right',
      render: (_, r) => <Text type="secondary">{r.tools?.length ?? '-'}</Text>,
    },
    {
      title: '操作', width: 160,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => setDetailServer(r)} style={{ padding: '0 4px' }}>详情</Button>
          <Popconfirm
            title="确认断开此服务器连接？"
            onConfirm={() => handleDisconnect(r.id)}
            disabled={r.status !== 'connected'}
            okText="断开" cancelText="取消"
          >
            <Button size="small" type="link" danger disabled={r.status !== 'connected'} style={{ padding: '0 4px' }}>断开</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>MCP 服务器</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>管理外部工具服务器连接</Text>
        </div>
        <Space size={8}>
          <Button icon={<ReloadOutlined />} onClick={fetchServers} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setConnectOpen(true)}>连接服务器</Button>
        </Space>
      </div>

      <Card style={{ borderRadius: 12, border: '1px solid #f0f0f0' }} styles={{ body: { padding: 0 } }}>
        <Table
          dataSource={servers}
          columns={columns}
          rowKey="id"
          loading={loading}
          locale={{ emptyText: '暂无已连接的 MCP 服务器' }}
          pagination={{ pageSize: COMPACT_PAGE_SIZE, showTotal: (t) => `共 ${t} 台`, style: { padding: '12px 16px' } }}
          style={{ borderRadius: 12, overflow: 'hidden' }}
        />
      </Card>

      <ConnectDrawer
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onSuccess={() => { setConnectOpen(false); fetchServers(); }}
      />
      <ServerDetailDrawer
        server={detailServer}
        onClose={() => setDetailServer(null)}
      />
    </div>
  );
}
