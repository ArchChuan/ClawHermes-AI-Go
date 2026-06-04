# API Development Rules

## Route Registration

所有路由集中注册于 `api/router.go`，禁止在 handler 文件中散落注册。

```go
// 路由组织方式
authRoutes  := router.Group("/auth")
adminGroup  := router.Group("/admin",  jwtMW, middleware.RequireGlobalAdmin())
tenantGroup := router.Group("/tenant", jwtMW, middleware.RequireTenantRole("member"))
skills      := router.Group("/skills")
agents      := router.Group("/agents")
knowledge   := router.Group("/knowledge")
mem         := router.Group("/memory")
// MCP 路由由 mcpHandler.RegisterRoutes(router) 动态注册
```

## Complete Route List

### 无需认证

| 方法 | 路径 | Handler |
|------|------|---------|
| GET | `/health` | 内联函数 |
| GET | `/metrics` | PrometheusMetrics.GetHandler() |

### Auth（需配置 GitHub OAuth）

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| GET | `/auth/github` | AuthHandler.GitHubLogin |
| GET | `/auth/github/callback` | AuthHandler.GitHubCallback |
| POST | `/auth/register` | AuthHandler.Register |
| POST | `/auth/refresh` | AuthHandler.Refresh |
| POST | `/auth/logout` | AuthHandler.Logout |
| GET | `/auth/me` | AuthHandler.Me |

### Admin（JWT + global_admin 角色）

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| GET | `/admin/tenants` | AdminHandler.ListTenants |
| POST | `/admin/tenants` | AdminHandler.CreateTenant |
| GET | `/admin/tenants/:id` | AdminHandler.GetTenant |
| PATCH | `/admin/tenants/:id` | AdminHandler.UpdateTenant |
| DELETE | `/admin/tenants/:id` | AdminHandler.DeleteTenant |

### Tenant（JWT + member 角色）

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| GET | `/tenant/members` | TenantHandler.ListMembers |
| POST | `/tenant/members/invite` | TenantHandler.InviteMember（需 admin/owner）|
| PATCH | `/tenant/members/:user_id/role` | TenantHandler.UpdateMemberRole |
| DELETE | `/tenant/members/:user_id` | TenantHandler.RemoveMember |
| GET | `/tenant/settings` | TenantHandler.GetSettings |
| PATCH | `/tenant/settings` | TenantHandler.UpdateSettings |

### Skill

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| GET | `/skills` | SkillHandler.GetAllSkills |
| POST | `/skills` | SkillHandler.CreateSkill |
| GET | `/skills/:id` | SkillHandler.GetSkill |
| PUT | `/skills/:id` | SkillHandler.UpdateSkill |
| DELETE | `/skills/:id` | SkillHandler.DeleteSkill |

### Agent

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| GET | `/agents` | AgentHandler.GetAllAgents |
| POST | `/agents` | AgentHandler.CreateAgent |
| GET | `/agents/:id` | AgentHandler.GetAgent |
| POST | `/agents/:id/execute` | AgentHandler.ExecuteAgent |
| DELETE | `/agents/:id` | AgentHandler.DeleteAgent |

### Knowledge（RAG）

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| POST | `/knowledge/ingest` | RAGHandler.UploadDocument |
| POST | `/knowledge/query` | RAGHandler.Query |

### Memory

| 方法 | 路径 | Handler 方法 |
|------|------|-------------|
| POST | `/memory/sessions` | MemoryHandler.CreateSession |
| POST | `/memory` | MemoryHandler.AddMemory |
| GET | `/memory/:id` | MemoryHandler.GetMemory |
| POST | `/memory/search` | MemoryHandler.SearchMemory |
| DELETE | `/memory/:id` | MemoryHandler.DeleteMemory |
| GET | `/memory/stats` | MemoryHandler.GetStats |
| DELETE | `/memory/session/:session_id` | MemoryHandler.ClearSession |
| GET | `/memory/entities` | MemoryHandler.GetEntities |
| POST | `/memory/extract-entities` | MemoryHandler.ExtractEntities |
| GET | `/memory/summary/:session_id` | MemoryHandler.GetSummary |

## Handler Writing Standards

### File Naming

每域一个文件：`handler/skill_handler.go`、`handler/agent_handler.go`、`handler/memory_handler.go` 等。

### Struct Pattern

```go
type SkillHandler struct {
    registry *orchestrator.Registry
    logger   *zap.Logger
}

func NewSkillHandler(registry *orchestrator.Registry, logger *zap.Logger, ...) *SkillHandler {
    return &SkillHandler{registry: registry, logger: logger}
}
```

### Request/Response

- Request 结构体定义在 `api/model/` 目录
- 用 `c.ShouldBindJSON(&req)` 绑定，失败返回 400
- 成功：`c.JSON(http.StatusOK, data)`
- 失败：`c.JSON(statusCode, model.ErrorResponse{Code: ..., Message: ...})`

### HTTP 状态码约定

| HTTP 状态 | 场景 |
|-----------|------|
| 200 | 查询/更新成功 |
| 201 | 创建成功 |
| 400 | 请求参数非法 |
| 401 | 未认证 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 资源冲突（重复创建）|
| 500 | 内部错误 |

## Middleware

注册顺序：ErrorHandler → MetricsMiddleware → Routes

| 文件 | 功能 |
|------|------|
| `middleware/metrics.go` | Prometheus 请求指标收集 |
| `middleware/prometheus.go` | PrometheusMetrics 实现 |
| `middleware/trace.go` | OpenTelemetry Span 注入 |
| `middleware/require_role.go` | `RequireGlobalAdmin()` / `RequireTenantRole(role)` |
| `middleware/tenant.go` | 从 JWT Claims 提取 tenant_id 注入 context |

## New Endpoint Checklist

1. 在 `api/model/` 中定义 Request/Response 结构体
2. 在 `handler/` 对应文件中实现 handler 方法
3. 在 `router.go` 注册路由（指定正确的 middleware 链）
4. 确认 Metrics 覆盖（MetricsMiddleware 全局生效）
5. 运行 `go build ./...` 验证编译
6. 编写 `*_test.go` 用 httptest 覆盖主路径
