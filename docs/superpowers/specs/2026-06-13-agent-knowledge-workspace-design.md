# Agent 挂载知识库设计

**日期**: 2026-06-13
**分支**: feat/tenant-suspend-enforcement
**状态**: 已批准，待实现

---

## 背景

前端创建/编辑 Agent 时需要能挂载当前租户内的知识库（RAG workspace），Agent 执行时可以通过 ReAct tool 动态检索知识库内容。

---

## 目标

1. 前端 CreateAgentPage / EditAgentPage 新增知识库多选 UI
2. 后端持久化 Agent ↔ Workspace 多对多关系
3. Agent 执行时将挂载的 workspace 暴露为 `search_knowledge` ReAct tool

---

## 数据层

### 新增关联表

```sql
CREATE TABLE IF NOT EXISTS agent_workspaces (
    agent_id     UUID REFERENCES agents(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES rag_workspaces(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, workspace_id)
);
```

位置：`internal/migration/sql/tenant_schema.sql` 和 `pkg/tenantdb/tenant_schema.sql`

### AgentConfig 变更

```go
// internal/agent/agent.go
type AgentConfig struct {
    // ... 现有字段 ...
    KnowledgeWorkspaceIDs []string  // 新增
}
```

### API DTO 变更

```go
// api/model/agent.go
type CreateAgentRequest struct {
    // ... 现有字段 ...
    KnowledgeWorkspaceIDs []string `json:"knowledge_workspace_ids"`
}
```

`UpdateAgentRequest`（同文件）同步新增该字段。

### Handler 变更（api/handler/agent_handler.go）

- **Create**：INSERT INTO agent_workspaces 写入关联
- **Update**：先 DELETE 旧关联，再 INSERT 新关联（事务内）
- **Get / List**：LEFT JOIN agent_workspaces + rag_workspaces，填充 `knowledge_workspace_ids` 到响应

---

## 执行层 — search_knowledge Tool

Agent 初始化时（`internal/agent/agent.go` BuildReActGraph 调用前），若 `KnowledgeWorkspaceIDs` 非空，动态注册：

```
Tool name:        search_knowledge
Description:      在知识库中检索相关文档。可用 workspace：[ws1, ws2, ...]
Parameters:
  workspace  string  required  枚举：已挂载的 workspace name 列表
  query      string  required  检索查询
  top_k      int     optional  返回条数，默认 5，最大 20
Returns:  []{ content: string, score: float, source: string }
```

调用链：

```
ReAct tool node
  → ToolRegistry.Execute("search_knowledge", args)
  → internal/knowledge/searcher.Search(ctx, workspaceName, query, topK)
  → Milvus 向量检索（复用 RAGHandler 已有逻辑）
```

约束：

- `workspace` 参数值必须在 agent 挂载列表内；违反时返回 tool error，不 panic
- Agent 无挂载 workspace 时不注册此 tool，tool list 不变
- 返回结果序列化为字符串注入 ReAct 上下文

---

## 前端 UI

### 新增 API 调用

`api.js` 已有 `getKnowledgeWorkspaces`，复用。

### CreateAgentPage / EditAgentPage

在"允许使用的技能"(`allowedSkills`) Form.Item 下方新增：

```jsx
<Form.Item label="知识库" name="knowledgeWorkspaceIds">
  <Select
    mode="multiple"
    placeholder="选择要挂载的知识库"
    loading={loadingWorkspaces}
    optionFilterProp="label"
    options={workspaces.map(w => ({ value: w.id, label: w.name }))}
  />
</Form.Item>
```

- 页面 mount 时并行拉取 workspaces（与 skills、models 同批 Promise.allSettled）
- `onFinish` 透传 `knowledgeWorkspaceIds` 到 createAgent / updateAgent payload
- EditAgentPage：`form.setFieldsValue({ knowledgeWorkspaceIds: agent.knowledge_workspace_ids })`

---

## 不在本次范围

- 知识库检索结果的 citation / source 高亮展示
- workspace 访问权限控制（目前租户内所有 workspace 均可挂载）
- top_k 在 UI 上的配置（固定默认值 5）
