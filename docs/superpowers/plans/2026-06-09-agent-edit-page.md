# Agent Edit Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `/agents/:id/edit` 编辑页，同时修复 `allowed_skills` 从未持久化的 bug。

**Architecture:** 新增数据库迁移加 `allowed_skills TEXT[]` 列；在 `AgentConfig` 补字段；`Registry` 增 `Update` 方法；新增 `PUT /agents/:id` 端点；前端新建 `EditAgentPage.jsx` 并在 `AgentsListPage` 加入编辑入口。

**Tech Stack:** Go 1.22 · pgx v5 · pgxmock · Gin v1.9 · React 18 · Ant Design 5

---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 新建 | `internal/migration/sql/005_add_agent_allowed_skills.up.sql` |
| 新建 | `internal/migration/sql/005_add_agent_allowed_skills.down.sql` |
| 修改 | `pkg/tenantdb/tenant_schema.sql` — agents 表加 `allowed_skills` 列 |
| 修改 | `internal/agent/agent.go` — `AgentConfig` 加 `AllowedSkills []string` |
| 修改 | `internal/agent/registry.go` — `Register`/`Get`/`GetAll` 含 `allowed_skills`；新增 `Update` 方法 |
| 修改 | `internal/agent/registry_test.go` — 更新旧测试 mock 列；新增 `Update` 测试 |
| 修改 | `api/handler/agent_handler.go` — `CreateAgent`/`GetAgent`/`GetAllAgents` 使用 `AllowedSkills`；新增 `UpdateAgent` handler；新增 `UpdateAgentRequest` 类型 |
| 修改 | `api/router.go` — 注册 `PUT /agents/:id` |
| 修改 | `web/src/services/api.js` — 新增 `getAgentById`、`updateAgent` |
| 新建 | `web/src/pages/EditAgentPage.jsx` |
| 修改 | `web/src/App.jsx` — 注册 `/agents/:id/edit` 路由 |
| 修改 | `web/src/pages/AgentsListPage.jsx` — 表格加编辑按钮 |

---

### Task 1: 数据库迁移 — 添加 `allowed_skills` 列

**Files:**

- Create: `internal/migration/sql/005_add_agent_allowed_skills.up.sql`
- Create: `internal/migration/sql/005_add_agent_allowed_skills.down.sql`
- Modify: `pkg/tenantdb/tenant_schema.sql`

- [ ] **Step 1: 写 up 迁移**

```sql
-- internal/migration/sql/005_add_agent_allowed_skills.up.sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_skills TEXT[] NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: 写 down 迁移**

```sql
-- internal/migration/sql/005_add_agent_allowed_skills.down.sql
ALTER TABLE agents DROP COLUMN IF EXISTS allowed_skills;
```

- [ ] **Step 3: 更新 tenant_schema.sql**

在 `pkg/tenantdb/tenant_schema.sql` 的 `agents` 表定义中，`max_iterations` 行之后加一行：

```sql
    max_iterations INT  NOT NULL DEFAULT 10,
    allowed_skills TEXT[] NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
```

（将原来 `max_iterations` 到 `created_at` 之间替换为上面两行）

- [ ] **Step 4: 提交**

```bash
git add internal/migration/sql/005_add_agent_allowed_skills.up.sql \
        internal/migration/sql/005_add_agent_allowed_skills.down.sql \
        pkg/tenantdb/tenant_schema.sql
git commit -m "feat(migration): add allowed_skills column to agents table"
```

---

### Task 2: 更新 `AgentConfig` 结构体

**Files:**

- Modify: `internal/agent/agent.go:81-91`

- [ ] **Step 1: 添加字段**

将 `internal/agent/agent.go` 中的 `AgentConfig` 替换为：

```go
type AgentConfig struct {
    ID            string
    Name          string
    Type          AgentType
    Description   string
    Persona       string
    SystemPrompt  string
    LLMModel      string
    MaxIterations int
    Capabilities  []AgentCapability
    AllowedSkills []string
}
```

- [ ] **Step 2: 确认编译通过**

```bash
go vet ./internal/agent/...
```

期望：无错误输出。

- [ ] **Step 3: 提交**

```bash
git add internal/agent/agent.go
git commit -m "feat(agent): add AllowedSkills to AgentConfig"
```

---

### Task 3: 更新 Registry — Register/Get/GetAll + 新增 Update

**Files:**

- Modify: `internal/agent/registry.go`

- [ ] **Step 1: 修改 `Register` — 加 `allowed_skills` 第 9 个参数**

将 `registry.go` 中 `Register` 方法的 `tx.Exec` 调用替换为：

```go
func (r *Registry) Register(ctx context.Context, a Agent) error {
    cfg := a.GetConfig()
    return r.execTenant(ctx, func(ctx context.Context, tx pgx.Tx) error {
        skills := cfg.AllowedSkills
        if skills == nil {
            skills = []string{}
        }
        _, err := tx.Exec(ctx,
            `INSERT INTO agents (id, name, type, description, persona, system_prompt, llm_model, max_iterations, allowed_skills)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            cfg.ID, cfg.Name, string(cfg.Type), cfg.Description,
            cfg.Persona, cfg.SystemPrompt, cfg.LLMModel, cfg.MaxIterations,
            skills,
        )
        if err != nil {
            return fmt.Errorf("register agent %s: %w", cfg.ID, err)
        }
        r.logger.Info("agent registered", zap.String("agent_id", cfg.ID))
        return nil
    })
}
```

- [ ] **Step 2: 修改 `Get` — SELECT 加 `allowed_skills`**

将 `Get` 方法中的 `QueryRow` + `Scan` 替换为：

```go
func (r *Registry) Get(ctx context.Context, id string) (Agent, bool) {
    var cfg AgentConfig
    var agentType string
    err := r.execTenant(ctx, func(ctx context.Context, tx pgx.Tx) error {
        return tx.QueryRow(ctx,
            `SELECT id, name, type, description, persona, system_prompt, llm_model, max_iterations, allowed_skills
             FROM agents WHERE id = $1`, id).
            Scan(&cfg.ID, &cfg.Name, &agentType, &cfg.Description,
                &cfg.Persona, &cfg.SystemPrompt, &cfg.LLMModel, &cfg.MaxIterations, &cfg.AllowedSkills)
    })
    if err != nil {
        return nil, false
    }
    if cfg.AllowedSkills == nil {
        cfg.AllowedSkills = []string{}
    }
    cfg.Type = AgentType(agentType)
    a := NewBaseAgent(&cfg, r.logger)
    if r.temporalClient != nil {
        a.SetTemporalClient(r.temporalClient)
    }
    return a, true
}
```

- [ ] **Step 3: 修改 `GetAll` — SELECT + Scan 加 `allowed_skills`**

将 `GetAll` 方法中的 `Query` SQL 和 `Scan` 替换：

```go
func (r *Registry) GetAll(ctx context.Context) []Agent {
    var agents []Agent
    _ = r.execTenant(ctx, func(ctx context.Context, tx pgx.Tx) error {
        rows, err := tx.Query(ctx,
            `SELECT id, name, type, description, persona, system_prompt, llm_model, max_iterations, allowed_skills
             FROM agents ORDER BY created_at`)
        if err != nil {
            return err
        }
        defer rows.Close()
        for rows.Next() {
            var cfg AgentConfig
            var agentType string
            if err := rows.Scan(&cfg.ID, &cfg.Name, &agentType, &cfg.Description,
                &cfg.Persona, &cfg.SystemPrompt, &cfg.LLMModel, &cfg.MaxIterations, &cfg.AllowedSkills); err != nil {
                r.logger.Warn("scan agent row", zap.Error(err))
                continue
            }
            if cfg.AllowedSkills == nil {
                cfg.AllowedSkills = []string{}
            }
            cfg.Type = AgentType(agentType)
            a := NewBaseAgent(&cfg, r.logger)
            if r.temporalClient != nil {
                a.SetTemporalClient(r.temporalClient)
            }
            agents = append(agents, a)
        }
        return rows.Err()
    })
    return agents
}
```

- [ ] **Step 4: 新增 `Update` 方法**

在 `registry.go` `GetAll` 方法之后追加：

```go
// Update replaces a persisted agent's mutable fields. Returns an error wrapping
// ErrNotFound (checked with errors.Is) when the agent does not exist.
var ErrNotFound = errors.New("agent not found")

func (r *Registry) Update(ctx context.Context, cfg *AgentConfig) error {
    skills := cfg.AllowedSkills
    if skills == nil {
        skills = []string{}
    }
    return r.execTenant(ctx, func(ctx context.Context, tx pgx.Tx) error {
        tag, err := tx.Exec(ctx,
            `UPDATE agents
             SET name=$1, description=$2, persona=$3, system_prompt=$4,
                 llm_model=$5, max_iterations=$6, allowed_skills=$7,
                 updated_at=NOW()
             WHERE id=$8`,
            cfg.Name, cfg.Description, cfg.Persona, cfg.SystemPrompt,
            cfg.LLMModel, cfg.MaxIterations, skills, cfg.ID,
        )
        if err != nil {
            return fmt.Errorf("update agent %s: %w", cfg.ID, err)
        }
        if tag.RowsAffected() == 0 {
            return fmt.Errorf("update agent %s: %w", cfg.ID, ErrNotFound)
        }
        r.logger.Info("agent updated", zap.String("agent_id", cfg.ID))
        return nil
    })
}
```

在文件顶部 import 块加 `"errors"`。

- [ ] **Step 5: 编译检查**

```bash
go vet ./internal/agent/...
```

期望：无错误。

- [ ] **Step 6: 提交**

```bash
git add internal/agent/registry.go
git commit -m "feat(registry): add allowed_skills to Register/Get/GetAll; add Update method"
```

---

### Task 4: 更新 Registry 单元测试

**Files:**

- Modify: `internal/agent/registry_test.go`

- [ ] **Step 1: 更新 `TestRegistry_Register` 的 mock 期望**

将 `TestRegistry_Register` 中的 `pool.ExpectExec("INSERT INTO agents")` 改为匹配 9 列 INSERT，mockAgent 加 `AllowedSkills`：

```go
func TestRegistry_Register(t *testing.T) {
    pool, err := pgxmock.NewPool()
    if err != nil {
        t.Fatal(err)
    }
    defer pool.Close()

    pool.ExpectBegin()
    pool.ExpectExec("SET LOCAL search_path").WillReturnResult(pgxmock.NewResult("SET", 0))
    pool.ExpectExec("INSERT INTO agents").
        WithArgs("a1", "Alpha", string(ReActAgent), "", "", "", "gpt-4o", 5, pgxmock.AnyArg()).
        WillReturnResult(pgxmock.NewResult("INSERT", 1))
    pool.ExpectCommit()

    reg := &Registry{pool: pool, logger: zap.NewNop()}
    a := &mockAgent{config: &AgentConfig{
        ID: "a1", Name: "Alpha", Type: ReActAgent,
        LLMModel: "gpt-4o", MaxIterations: 5,
        AllowedSkills: []string{},
    }}
    if err := reg.Register(tenantCtx("t1"), a); err != nil {
        t.Fatalf("Register: %v", err)
    }
    if err := pool.ExpectationsWereMet(); err != nil {
        t.Errorf("unmet expectations: %v", err)
    }
}
```

- [ ] **Step 2: 更新 `TestRegistry_Get` 的 mock 列**

将 `TestRegistry_Get` 中 `WillReturnRows` 的列列表加 `"allowed_skills"`，行值加 `[]string{}`：

```go
pool.ExpectQuery("SELECT id, name").
    WithArgs(pgxmock.AnyArg()).
    WillReturnRows(pgxmock.NewRows([]string{
        "id", "name", "type", "description", "persona",
        "system_prompt", "llm_model", "max_iterations", "allowed_skills",
    }).AddRow("a1", "Alpha", string(ReActAgent), "", "", "", "gpt-4o", 5, []string{}))
```

同理更新 `TestRegistry_GetNotFound`（只需在 `NewRows` 列列表加 `"allowed_skills"`，无需加行）：

```go
pool.ExpectQuery("SELECT id, name").
    WithArgs("missing").
    WillReturnRows(pgxmock.NewRows([]string{
        "id", "name", "type", "description", "persona",
        "system_prompt", "llm_model", "max_iterations", "allowed_skills",
    }))
```

- [ ] **Step 3: 新增 `TestRegistry_Update_Success`**

```go
func TestRegistry_Update_Success(t *testing.T) {
    pool, err := pgxmock.NewPool()
    if err != nil {
        t.Fatal(err)
    }
    defer pool.Close()

    pool.ExpectBegin()
    pool.ExpectExec("SET LOCAL search_path").WillReturnResult(pgxmock.NewResult("SET", 0))
    pool.ExpectExec("UPDATE agents").
        WithArgs("Alpha2", "", "", "", "gpt-4o", 5, pgxmock.AnyArg(), "a1").
        WillReturnResult(pgxmock.NewResult("UPDATE", 1))
    pool.ExpectCommit()

    reg := &Registry{pool: pool, logger: zap.NewNop()}
    cfg := &AgentConfig{
        ID: "a1", Name: "Alpha2", Type: ReActAgent,
        LLMModel: "gpt-4o", MaxIterations: 5,
        AllowedSkills: []string{},
    }
    if err := reg.Update(tenantCtx("t1"), cfg); err != nil {
        t.Fatalf("Update: %v", err)
    }
    if err := pool.ExpectationsWereMet(); err != nil {
        t.Errorf("unmet expectations: %v", err)
    }
}
```

- [ ] **Step 4: 新增 `TestRegistry_Update_NotFound`**

```go
func TestRegistry_Update_NotFound(t *testing.T) {
    pool, err := pgxmock.NewPool()
    if err != nil {
        t.Fatal(err)
    }
    defer pool.Close()

    pool.ExpectBegin()
    pool.ExpectExec("SET LOCAL search_path").WillReturnResult(pgxmock.NewResult("SET", 0))
    pool.ExpectExec("UPDATE agents").
        WillReturnResult(pgxmock.NewResult("UPDATE", 0))
    pool.ExpectRollback()

    reg := &Registry{pool: pool, logger: zap.NewNop()}
    cfg := &AgentConfig{ID: "missing", Name: "X", LLMModel: "gpt-4o", MaxIterations: 1}
    err = reg.Update(tenantCtx("t1"), cfg)
    if err == nil {
        t.Fatal("expected error")
    }
    if !errors.Is(err, ErrNotFound) {
        t.Errorf("expected ErrNotFound, got: %v", err)
    }
}
```

- [ ] **Step 5: 跑测试**

```bash
go test -v -race -timeout 30s ./internal/agent/...
```

期望：所有测试 PASS，无 race。

- [ ] **Step 6: 提交**

```bash
git add internal/agent/registry_test.go
git commit -m "test(registry): update mocks for allowed_skills; add Update tests"
```

---

### Task 5: 更新 Agent Handler — CreateAgent/GetAgent/GetAllAgents + 新增 UpdateAgent

**Files:**

- Modify: `api/handler/agent_handler.go`

- [ ] **Step 1: 新增 `UpdateAgentRequest` 类型**

在 `agent_handler.go` 的 `CreateAgentRequest` 定义之后插入：

```go
type UpdateAgentRequest struct {
    Name          string   `json:"name" binding:"required"`
    Description   string   `json:"description"`
    Persona       string   `json:"persona"`
    SystemPrompt  string   `json:"systemPrompt"`
    LLMModel      string   `json:"llmModel" binding:"required"`
    MaxIterations int      `json:"maxIterations" binding:"required"`
    AllowedSkills []string `json:"allowedSkills"`
}
```

- [ ] **Step 2: 修改 `CreateAgent` — 写入 `AllowedSkills` 到 cfg**

将 `CreateAgent` 中构建 `cfg` 的代码替换为：

```go
skills := req.AllowedSkills
if skills == nil {
    skills = []string{}
}
cfg := &agent.AgentConfig{
    ID:            id,
    Name:          req.Name,
    Type:          agentType,
    Description:   req.Description,
    Persona:       req.Persona,
    SystemPrompt:  req.SystemPrompt,
    LLMModel:      req.LLMModel,
    MaxIterations: req.MaxIterations,
    Capabilities:  []agent.AgentCapability{},
    AllowedSkills: skills,
}
```

同时将 `CreateAgent` 末尾的 `c.JSON(http.StatusCreated, AgentResponse{...})` 中的 `AllowedSkills: []string{}` 改为 `AllowedSkills: skills`。

- [ ] **Step 3: 修改 `GetAgent` — 返回真实 `AllowedSkills`**

将 `GetAgent` 中的 `c.JSON` 调用替换为：

```go
cfg := a.GetConfig()
c.JSON(http.StatusOK, AgentResponse{
    ID:            cfg.ID,
    Name:          cfg.Name,
    Type:          string(cfg.Type),
    Description:   cfg.Description,
    Persona:       cfg.Persona,
    SystemPrompt:  cfg.SystemPrompt,
    LLMModel:      cfg.LLMModel,
    MaxIterations: cfg.MaxIterations,
    AllowedSkills: cfg.AllowedSkills,
    CreatedAt:     time.Now().Format(time.RFC3339),
})
```

- [ ] **Step 4: 修改 `GetAllAgents` — 返回真实 `AllowedSkills`**

将 `GetAllAgents` 中构建 `responses` 的循环替换为：

```go
for _, a := range agents {
    cfg := a.GetConfig()
    responses = append(responses, AgentResponse{
        ID:            cfg.ID,
        Name:          cfg.Name,
        Type:          string(cfg.Type),
        Description:   cfg.Description,
        Persona:       cfg.Persona,
        SystemPrompt:  cfg.SystemPrompt,
        LLMModel:      cfg.LLMModel,
        MaxIterations: cfg.MaxIterations,
        AllowedSkills: cfg.AllowedSkills,
        CreatedAt:     time.Now().Format(time.RFC3339),
    })
}
```

- [ ] **Step 5: 新增 `UpdateAgent` 方法**

在 `DeleteAgent` 方法之前插入：

```go
func (h *AgentHandler) UpdateAgent(c *gin.Context) {
    if _, ok := tenantIDFromCtx(c); !ok {
        respondMissingTenant(c)
        return
    }
    id := c.Param("id")
    var req UpdateAgentRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        h.logger.Warn("invalid update request", zap.Error(err))
        c.JSON(http.StatusBadRequest, model.ErrorResponse{
            Code:    http.StatusBadRequest,
            Message: err.Error(),
        })
        return
    }

    skills := req.AllowedSkills
    if skills == nil {
        skills = []string{}
    }

    agentType := agent.ReActAgent
    // type is not updatable; we get it from existing record
    a, ok := h.agentRegistry.Get(c.Request.Context(), id)
    if !ok {
        c.JSON(http.StatusNotFound, model.ErrorResponse{
            Code:    http.StatusNotFound,
            Message: "agent not found",
        })
        return
    }
    agentType = a.GetConfig().Type

    cfg := &agent.AgentConfig{
        ID:            id,
        Name:          req.Name,
        Type:          agentType,
        Description:   req.Description,
        Persona:       req.Persona,
        SystemPrompt:  req.SystemPrompt,
        LLMModel:      req.LLMModel,
        MaxIterations: req.MaxIterations,
        AllowedSkills: skills,
    }

    if err := h.agentRegistry.Update(c.Request.Context(), cfg); err != nil {
        if errors.Is(err, agent.ErrNotFound) {
            c.JSON(http.StatusNotFound, model.ErrorResponse{
                Code:    http.StatusNotFound,
                Message: "agent not found",
            })
            return
        }
        h.logger.Error("failed to update agent", zap.String("id", id), zap.Error(err))
        c.JSON(http.StatusInternalServerError, model.ErrorResponse{
            Code:    http.StatusInternalServerError,
            Message: fmt.Sprintf("failed to update agent: %v", err),
        })
        return
    }

    h.logger.Info("agent updated", zap.String("id", id))
    c.JSON(http.StatusOK, AgentResponse{
        ID:            id,
        Name:          req.Name,
        Type:          string(agentType),
        Description:   req.Description,
        Persona:       req.Persona,
        SystemPrompt:  req.SystemPrompt,
        LLMModel:      req.LLMModel,
        MaxIterations: req.MaxIterations,
        AllowedSkills: skills,
        CreatedAt:     time.Now().Format(time.RFC3339),
    })
}
```

在文件顶部 import 块确认有 `"errors"`。

- [ ] **Step 6: 编译检查**

```bash
go vet ./api/handler/...
```

期望：无错误。

- [ ] **Step 7: 提交**

```bash
git add api/handler/agent_handler.go
git commit -m "feat(handler): fix AllowedSkills in Create/Get/GetAll; add UpdateAgent endpoint"
```

---

### Task 6: 注册路由

**Files:**

- Modify: `api/router.go`

- [ ] **Step 1: 定位 agents 路由组**

在 `api/router.go` 中找到类似：

```go
agents := v1.Group("/agents", requireActive)
agents.GET("", agentHandler.GetAllAgents)
agents.GET("/:id", agentHandler.GetAgent)
agents.POST("", agentHandler.CreateAgent)
```

- [ ] **Step 2: 追加 PUT 路由**

在 `agents.POST` 行之后加：

```go
agents.PUT("/:id", agentHandler.UpdateAgent)
```

- [ ] **Step 3: 编译并运行 vet**

```bash
go vet ./api/...
```

期望：无错误。

- [ ] **Step 4: 提交**

```bash
git add api/router.go
git commit -m "feat(router): register PUT /agents/:id"
```

---

### Task 7: 前端 API 层

**Files:**

- Modify: `web/src/services/api.js`

- [ ] **Step 1: 找到 `createAgent` 定义位置**

搜索 `api.js` 中 `createAgent` 的位置（约在 100 行附近）。

- [ ] **Step 2: 添加 `getAgentById` 和 `updateAgent`**

在 `createAgent` 的同一区域追加两行：

```js
export const getAgentById = (id) => api.get(`/api/v1/agents/${id}`);
export const updateAgent = (id, data) => api.put(`/api/v1/agents/${id}`, data);
```

（与 `getAllAgents` 等保持相同 baseURL 前缀 `/api/v1/agents`，以现有函数为准。）

- [ ] **Step 3: 验证**

```bash
cd web && npm run build 2>&1 | tail -20
```

期望：Build succeeded，无 ERROR。

- [ ] **Step 4: 提交**

```bash
git add web/src/services/api.js
git commit -m "feat(api): add getAgentById and updateAgent"
```

---

### Task 8: 新建 EditAgentPage.jsx

**Files:**

- Create: `web/src/pages/EditAgentPage.jsx`

- [ ] **Step 1: 写页面组件**

```jsx
import React, { useState, useEffect } from 'react';
import {
  Form, Input, Select, Button, Card, Space,
  Typography, notification, InputNumber, Tag, message,
} from 'antd';
import { getAgentById, updateAgent, getAllSkills, getAvailableModels } from '../services/api';
import { useNavigate, useParams } from 'react-router-dom';

const { Title } = Typography;
const { Option } = Select;
const { TextArea } = Input;

const FALLBACK_MODELS = ['glm-4', 'glm-4-flash', 'qwen-plus', 'qwen-turbo'];

const EditAgentPage = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [skills, setSkills] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(true);
  const navigate = useNavigate();
  const { id } = useParams();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [modelsRes, skillsRes, agentRes] = await Promise.all([
          getAvailableModels().catch(() => ({ data: { models: [] } })),
          getAllSkills().catch(() => ({ data: { skills: [] } })),
          getAgentById(id),
        ]);
        if (cancelled) return;
        const models = modelsRes.data.models?.length > 0 ? modelsRes.data.models : FALLBACK_MODELS;
        setAvailableModels(models);
        setSkills(skillsRes.data.skills || []);
        const a = agentRes.data;
        form.setFieldsValue({
          name: a.name,
          description: a.description,
          persona: a.persona,
          systemPrompt: a.systemPrompt,
          llmModel: a.llmModel,
          maxIterations: a.maxIterations,
          allowedSkills: a.allowedSkills || [],
        });
      } catch (err) {
        if (cancelled) return;
        message.error(err.response?.data?.error || '加载代理失败');
        navigate('/agents');
      } finally {
        if (!cancelled) {
          setModelsLoading(false);
          setPageLoading(false);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFinish = async (values) => {
    setLoading(true);
    try {
      await updateAgent(id, values);
      notification.success({
        message: '更新成功',
        description: `智能代理 "${values.name}" 已成功更新`,
      });
      navigate('/agents');
    } catch (error) {
      if (error.response?.status === 404) {
        notification.error({ message: '代理不存在', description: error.response.data?.error });
      } else if (error.response?.status === 400) {
        notification.error({ message: '请求无效', description: error.response.data?.error });
      } else if (error.response?.status !== 403) {
        notification.error({
          message: '更新失败',
          description: error.response?.data?.error || error.message || '更新智能代理时发生错误',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  if (pageLoading) return null;

  return (
    <div>
      <Title level={2}>编辑智能代理</Title>
      <Card style={{ marginTop: 24 }}>
        <Form
          form={form}
          name="editAgent"
          labelCol={{ span: 6 }}
          wrapperCol={{ span: 14 }}
          layout="horizontal"
          onFinish={onFinish}
        >
          <Form.Item label="代理名称" name="name" rules={[{ required: true, message: '请输入代理名称!' }]}>
            <Input placeholder="请输入代理名称" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <TextArea rows={3} placeholder="请输入代理描述" />
          </Form.Item>
          <Form.Item label="角色设定" name="persona">
            <TextArea rows={4} placeholder="描述此代理的角色和行为特征" />
          </Form.Item>
          <Form.Item label="系统提示词" name="systemPrompt">
            <TextArea rows={6} placeholder="定义代理的行为准则和工作方式" />
          </Form.Item>
          <Form.Item label="LLM模型" name="llmModel" rules={[{ required: true, message: '请选择LLM模型!' }]}>
            <Select placeholder="请选择LLM模型" loading={modelsLoading}>
              {availableModels.map(model => (
                <Option key={model} value={model}>{model}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="最大迭代次数" name="maxIterations" rules={[{ required: true, message: '请输入最大迭代次数!' }]}>
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="允许使用的技能" name="allowedSkills">
            <Select mode="multiple" placeholder="选择此代理可以使用的技能" loading={skills.length === 0}>
              {skills.map(skill => (
                <Option key={skill.id} value={skill.id}>
                  <Tag color={skill.type === 'code' ? 'green' : skill.type === 'llm' ? 'orange' : 'default'}>
                    {skill.type}
                  </Tag>
                  {skill.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item wrapperCol={{ offset: 6, span: 14 }}>
            <Space size="middle">
              <Button type="primary" htmlType="submit" loading={loading}>保存</Button>
              <Button onClick={() => navigate('/agents')}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default EditAgentPage;
```

- [ ] **Step 2: 前端 lint 检查**

```bash
cd web && npm run lint 2>&1 | tail -20
```

期望：no errors（warnings 可忽略）。

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/EditAgentPage.jsx
git commit -m "feat(frontend): add EditAgentPage"
```

---

### Task 9: 注册前端路由 + 侧边栏入口

**Files:**

- Modify: `web/src/App.jsx`
- Modify: `web/src/pages/AgentsListPage.jsx`

- [ ] **Step 1: 在 App.jsx 导入 EditAgentPage**

在 `App.jsx` 的 `import CreateAgentPage` 行之后插入：

```jsx
import EditAgentPage from './pages/EditAgentPage';
```

- [ ] **Step 2: 注册路由**

在 `App.jsx` 的 `<Route path="/agents/create" ...>` 之后加：

```jsx
<Route path="/agents/:id/edit" element={<PrivateRoute><EditAgentPage /></PrivateRoute>} />
```

- [ ] **Step 3: 在 AgentsListPage 表格加编辑按钮**

找到 `AgentsListPage.jsx` 的操作列（有 `PlayCircleOutlined` 和 `DeleteOutlined` 的地方），加入编辑按钮。先在文件顶部 import 加 `EditOutlined` 和 `useNavigate`：

```jsx
import { PlusOutlined, PlayCircleOutlined, DeleteOutlined, RobotOutlined, EditOutlined } from '@ant-design/icons';
import { getAllAgents, executeAgent, deleteAgent } from '../services/api';
import { useNavigate } from 'react-router-dom';
```

在组件内加：

```jsx
const navigate = useNavigate();
```

在表格的操作列 `render` 函数中，在执行按钮之前插入编辑按钮：

```jsx
<Button
  type="link"
  icon={<EditOutlined />}
  onClick={() => navigate(`/agents/${record.id}/edit`)}
>
  编辑
</Button>
```

- [ ] **Step 4: 前端构建验证**

```bash
cd web && npm run build 2>&1 | tail -20
```

期望：Build succeeded。

- [ ] **Step 5: 提交**

```bash
git add web/src/App.jsx web/src/pages/AgentsListPage.jsx
git commit -m "feat(frontend): register /agents/:id/edit route; add edit button in AgentsListPage"
```

---

### Task 10: 全栈运行验证

- [ ] **Step 1: 运行后端测试**

```bash
go test -v -race -timeout 30s ./internal/agent/... ./api/...
```

期望：所有测试 PASS。

- [ ] **Step 2: 后端完整构建**

```bash
go build ./...
```

期望：无错误。

- [ ] **Step 3: 手动冒烟测试检查清单**

1. 打开 `/agents` 列表页 → 确认每行出现"编辑"按钮
2. 点击编辑 → 跳转 `/agents/{id}/edit` → 表单回填所有字段（name, description, persona, systemPrompt, llmModel, maxIterations, allowedSkills）
3. 修改名称 + allowedSkills → 点击"保存" → 成功提示 → 跳回列表
4. 再次点编辑同一条 → 确认修改后的值已显示
5. 访问不存在 ID（`/agents/nonexistent/edit`）→ 弹出错误提示 → 跳回列表

- [ ] **Step 4: 最终提交（如有未提交改动）**

```bash
git add -p
git commit -m "chore: final cleanup after agent edit page implementation"
```
