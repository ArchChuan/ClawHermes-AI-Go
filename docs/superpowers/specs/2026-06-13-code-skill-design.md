# Code Skill 完整链路设计

**日期**: 2026-06-13
**分支**: feat/code-skill
**作者**: byteBuilderX

---

## 背景

现有 `CodeSkill.Execute` 是空 stub，返回 `"Code execution not yet implemented"`。本设计实现 JavaScript 和 Python 两种语言的完整执行链路，包含静态安全分析、沙箱执行、全局并发控制和前后端交互变更。

---

## 整体架构

```
创建时                                  运行时
────────────────────────────────        ─────────────────────────────────────
用户提交 { type, language, code }       Agent / POST /skills/:id/run
    ↓
StaticAnalyzer.Check(lang, code)        CodeExecutor.Execute(ctx, skill, input)
    ├── Python: ast 扫描禁止名单             ↓
    └── JS: 正则扫危险全局变量          GlobalSemaphore.Acquire()
    ↓ 通过                                  ├── 满 → 返回 ErrConcurrencyLimit (429)
skill 写入 registry（status=active）        ↓
    ↓ 失败                             JS  → goja VM + ctx interrupt
400 + { analysis_errors: [...] }       Py  → subprocess + ulimit
                                            ↓
                                       GlobalSemaphore.Release()
                                            ↓
                                       { output, error, duration_ms }
```

---

## 新增 / 修改文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `internal/skill/analyzer.go` | 新增 | 静态分析器 |
| `internal/skill/code_executor.go` | 新增 | JS + Python 执行引擎 |
| `internal/skill/semaphore.go` | 新增 | 全局并发信号量 |
| `internal/skill/code_skill.go` | 修改 | Execute 委托给 code_executor |
| `api/handler/skill_handler.go` | 修改 | 创建时调静态分析；新增 /run 端点 |
| `api/model/request.go` | 修改 | CreateSkillRequest 新增 language 字段 |
| `web/src/pages/CreateSkillPage.jsx` | 修改 | 语言选择 + 分析错误展示 |
| `web/src/pages/SkillsListPage.jsx` | 修改 | 语言标签展示 |

---

## 静态分析

### Python 禁止名单

**禁止 import**：

```
os, sys, subprocess, shutil, socket, urllib, http, requests,
ctypes, threading, multiprocessing, signal, resource, pathlib,
importlib, builtins
```

**禁止内置调用**：

```
exec, eval, compile, open, __import__, globals, locals, vars,
getattr, setattr, delattr, dir
```

实现：将代码传给 `python3 -c "import ast, sys; ast.parse(sys.stdin.read())"` 验证语法，再用 Go AST walker 扫描 import 节点和 Call 节点名称。实际使用 Go 正则扫描 + 简单文本匹配（无需完整 Python 解析）。

### JavaScript 禁止名单

**禁止全局变量**：

```
process, require, __dirname, __filename, Buffer, global,
XMLHttpRequest, fetch, WebSocket, Worker, importScripts
```

**禁止模式**：

```
new Function(
__proto__
prototype.constructor
```

实现：Go 侧正则扫描，无需 Node.js。

### 接口

```go
type AnalysisResult struct {
    Safe    bool
    Reasons []string
}

type StaticAnalyzer interface {
    Check(lang, code string) AnalysisResult
}
```

---

## 执行引擎

### JavaScript（goja）

- 依赖：`github.com/dop251/goja`
- 用户代码必须定义 `function process(inputData) { return {...} }`
- 包装：`(function(){ <userCode>; return process(input); })()`
- 超时：从 ctx deadline 取，默认 10s，通过 `vm.Interrupt("timeout")` 强制中断
- 白名单注入：`JSON`、`Math`、`console.log`（重定向到 zap，不写 stderr）
- 不暴露：`process`、`require` 等任何 Node 全局

### Python（subprocess + ulimit）

- 用户代码必须定义 `def process(input_data): return {...}`
- 包装模板：

  ```python
  import sys, json
  input_data = json.loads(sys.stdin.read())
  <userCode>
  print(json.dumps(process(input_data)))
  ```

- 资源限制（`prlimit` syscall via `SysProcAttr`）：
  - `RLIMIT_AS = 128MB`（虚拟内存）
  - `RLIMIT_CPU = 5s`（CPU 时间）
  - `RLIMIT_NOFILE = 16`（文件描述符）
- 进程组：`Setpgid: true`，超时后 `syscall.Kill(-pgid, syscall.SIGKILL)` 杀整树
- 通信：stdin 注入 `json(input)`，stdout 读 `json(output)`

### 全局并发控制

```go
// semaphore.go
type Semaphore struct {
    global    chan struct{}  // 全局槽位
    perTenant sync.Map      // tenant_id -> chan struct{}
}
```

配置（Viper）：

```yaml
code_executor:
  max_concurrent: 10     # 全局最大同时执行数
  per_tenant_max: 3      # 单租户最大同时执行数
  default_timeout_sec: 10
  python_memory_mb: 128
```

`Acquire` 失败返回 `ErrConcurrencyLimit`，handler 转为 HTTP 429。

---

## API 变更

### POST /skills（修改）

请求体新增字段：

```json
{
  "type": "code",
  "language": "python",
  "code": "def process(input_data):\n    return {'output': input_data}",
  "name": "my-skill",
  "description": "..."
}
```

失败响应（400）：

```json
{
  "code": 400,
  "message": "code analysis failed",
  "analysis_errors": ["forbidden import: os", "forbidden call: exec"]
}
```

### POST /skills/:id/run（新增）

```
POST /skills/:id/run
Authorization: Bearer <token>

{ "input": { "query": "hello" } }

200: { "output": { "result": "HELLO" }, "duration_ms": 45, "error": null }
429: { "code": 429, "message": "concurrency limit reached, try again later" }
```

---

## 权限矩阵

| 操作 | 最低角色 | 中间件 |
|------|----------|--------|
| 创建 / 修改 / 删除 code skill | member | RequireActiveTenant |
| POST /skills/:id/run | member | RequireActiveTenant |
| 超出并发上限 | — | 429，无角色判断 |

与现有 llm/http skill 保持一致，不引入额外角色。

---

## 前端变更

### CreateSkillPage.jsx

- 选 `code` 类型后显示：
  - 语言下拉（`python` / `javascript`）
  - 代码编辑区（`Input.TextArea`，placeholder 为对应语言模板）
- 提交失败且响应含 `analysis_errors` 时，展示错误列表而非通用 `操作失败`

### SkillsListPage.jsx

- code 类型 tag 旁展示语言小标签（`Python` / `JS`）

---

## 测试覆盖

| 测试 | 文件 |
|------|------|
| 静态分析：各禁止 pattern 均触发 | `internal/skill/analyzer_test.go` |
| JS 执行：正常返回、超时、语法错误 | `internal/skill/code_executor_test.go` |
| Python 执行：正常返回、超时、内存溢出 | `internal/skill/code_executor_test.go` |
| 并发信号量：全局上限、per-tenant 上限 | `internal/skill/semaphore_test.go` |
| Handler：创建时分析失败 400、/run 429 | `api/handler/skill_handler_test.go` |
