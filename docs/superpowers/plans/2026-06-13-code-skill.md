# Code Skill 执行链路实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 JavaScript 和 Python 代码技能的完整执行链路，含静态安全分析（创建时阻断）、沙箱执行（goja / subprocess+ulimit）、全局并发控制和前后端变更。

**Architecture:** 创建时 `StaticAnalyzer` 扫描禁止模式（纯 Go 正则，零外部依赖），通过才写入 registry；运行时 `CodeExecutor` 先从 `Semaphore` 获取槽位，JS 走 goja VM + ctx interrupt，Python 走 exec.CommandContext + prlimit 资源限制，结束后释放槽位。

**Tech Stack:** github.com/dop251/goja（JS interpreter）· exec.CommandContext + syscall.SysProcAttr（Python subprocess）· sync.Map + chan struct{}（semaphore）· Gin v1.9 · React 18 + Ant Design 5

---

## 文件映射

| 文件 | 操作 |
|------|------|
| `internal/skill/analyzer.go` | 新增 |
| `internal/skill/analyzer_test.go` | 新增 |
| `internal/skill/semaphore.go` | 新增 |
| `internal/skill/semaphore_test.go` | 新增 |
| `internal/skill/code_executor.go` | 新增 |
| `internal/skill/code_executor_test.go` | 新增 |
| `internal/skill/code_skill.go` | 修改：Execute 委托给 CodeExecutor |
| `api/handler/skill_handler.go` | 修改：CreateSkill/UpdateSkill 加静态分析；新增 RunSkill |
| `api/model/request.go` | 修改：新增 RunSkillRequest/RunSkillResponse；ErrorResponse 新增 AnalysisErrors |
| `api/router.go` | 修改：新增 POST /skills/:id/run |
| `web/src/pages/CreateSkillPage.jsx` | 修改：语言选项仅 python/js；analysis_errors 展示 |
| `web/src/pages/SkillsListPage.jsx` | 修改：code 类型卡片展示语言标签 |

---

### Task 1: 安装 goja 依赖

**Files:**

- Modify: `go.mod`, `go.sum`

- [ ] **Step 1: 安装依赖**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go get github.com/dop251/goja@latest
```

Expected: 输出类似 `go: added github.com/dop251/goja v0.0.0-...`

- [ ] **Step 2: 验证编译**

```bash
go build ./...
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore(deps): add goja JS interpreter"
```

---

### Task 2: StaticAnalyzer（纯 Go 静态分析）

**Files:**

- Create: `internal/skill/analyzer.go`
- Create: `internal/skill/analyzer_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/skill/analyzer_test.go`：

```go
package skill

import (
 "testing"
)

func TestPythonAnalyzer_ForbiddenImport(t *testing.T) {
 a := NewStaticAnalyzer()
 cases := []struct {
  code    string
  wantSafe bool
 }{
  {`import os`, false},
  {`import sys`, false},
  {`import subprocess`, false},
  {`from os import path`, false},
  {`from os.path import join`, false},
  {`import json`, true},
  {`def process(d): return d`, true},
 }
 for _, tc := range cases {
  r := a.Check("python", tc.code)
  if r.Safe != tc.wantSafe {
   t.Errorf("python %q: got Safe=%v, want %v; reasons=%v", tc.code, r.Safe, tc.wantSafe, r.Reasons)
  }
 }
}

func TestPythonAnalyzer_ForbiddenBuiltin(t *testing.T) {
 a := NewStaticAnalyzer()
 cases := []struct {
  code    string
  wantSafe bool
 }{
  {`exec("rm -rf /")`, false},
  {`eval("1+1")`, false},
  {`__import__("os")`, false},
  {`open("/etc/passwd")`, false},
  {`compile("x","f","exec")`, false},
  {`result = input_data.get("x","")`, true},
 }
 for _, tc := range cases {
  r := a.Check("python", tc.code)
  if r.Safe != tc.wantSafe {
   t.Errorf("python %q: got Safe=%v, want %v; reasons=%v", tc.code, r.Safe, tc.wantSafe, r.Reasons)
  }
 }
}

func TestJSAnalyzer_ForbiddenGlobals(t *testing.T) {
 a := NewStaticAnalyzer()
 cases := []struct {
  code    string
  wantSafe bool
 }{
  {`process.exit(1)`, false},
  {`require("fs")`, false},
  {`fetch("http://evil.com")`, false},
  {`new Function("return 1")`, false},
  {`__proto__`, false},
  {`prototype.constructor`, false},
  {`function process(d){ return {out: d.query}; }`, true},
 }
 for _, tc := range cases {
  r := a.Check("javascript", tc.code)
  if r.Safe != tc.wantSafe {
   t.Errorf("js %q: got Safe=%v, want %v; reasons=%v", tc.code, r.Safe, tc.wantSafe, r.Reasons)
  }
 }
}

func TestAnalyzer_UnsupportedLang(t *testing.T) {
 a := NewStaticAnalyzer()
 r := a.Check("go", "package main")
 if r.Safe {
  t.Error("unsupported language should not be safe")
 }
}
```

- [ ] **Step 2: 运行确认测试失败**

```bash
go test ./internal/skill/... -run TestPythonAnalyzer -v 2>&1 | head -20
```

Expected: `FAIL` 或 `cannot find package`

- [ ] **Step 3: 实现 analyzer.go**

创建 `internal/skill/analyzer.go`：

```go
package skill

import (
 "fmt"
 "regexp"
 "strings"
)

// AnalysisResult holds static analysis outcome.
type AnalysisResult struct {
 Safe    bool
 Reasons []string
}

// StaticAnalyzer checks code for dangerous patterns before registration.
type StaticAnalyzer interface {
 Check(lang, code string) AnalysisResult
}

type staticAnalyzer struct{}

// NewStaticAnalyzer returns the default StaticAnalyzer.
func NewStaticAnalyzer() StaticAnalyzer { return &staticAnalyzer{} }

var (
 pyForbiddenImports = []string{
  "os", "sys", "subprocess", "shutil", "socket", "urllib", "http",
  "requests", "ctypes", "threading", "multiprocessing", "signal",
  "resource", "pathlib", "importlib", "builtins",
 }
 pyForbiddenBuiltins = []string{
  "exec", "eval", "compile", "open", "__import__",
  "globals", "locals", "vars", "getattr", "setattr", "delattr", "dir",
 }

 jsForbiddenGlobals = []string{
  "process", "require", "__dirname", "__filename", "Buffer", "global",
  "XMLHttpRequest", "fetch", "WebSocket", "Worker", "importScripts",
 }
 jsForbiddenPatterns = []*regexp.Regexp{
  regexp.MustCompile(`\bnew\s+Function\s*\(`),
  regexp.MustCompile(`__proto__`),
  regexp.MustCompile(`prototype\.constructor`),
 }
)

func (a *staticAnalyzer) Check(lang, code string) AnalysisResult {
 switch lang {
 case "python":
  return checkPython(code)
 case "javascript":
  return checkJS(code)
 default:
  return AnalysisResult{Safe: false, Reasons: []string{fmt.Sprintf("unsupported language: %s", lang)}}
 }
}

func checkPython(code string) AnalysisResult {
 var reasons []string
 lines := strings.Split(code, "\n")
 for _, raw := range lines {
  line := strings.TrimSpace(raw)
  // strip inline comments
  if idx := strings.Index(line, "#"); idx >= 0 {
   line = strings.TrimSpace(line[:idx])
  }
  if line == "" {
   continue
  }
  // import os / import os, sys / from os import ... / from os.path import ...
  for _, mod := range pyForbiddenImports {
   if matchPyImport(line, mod) {
    reasons = append(reasons, fmt.Sprintf("forbidden import: %s", mod))
   }
  }
  // builtin calls: exec(...) / eval(...) etc.
  for _, b := range pyForbiddenBuiltins {
   pat := regexp.MustCompile(`\b` + regexp.QuoteMeta(b) + `\s*\(`)
   if pat.MatchString(line) {
    reasons = append(reasons, fmt.Sprintf("forbidden call: %s", b))
   }
  }
 }
 return AnalysisResult{Safe: len(reasons) == 0, Reasons: reasons}
}

func matchPyImport(line, mod string) bool {
 // import <mod>  or  import <mod>,  or  import <mod>.<sub>
 importRe := regexp.MustCompile(`^import\s+` + regexp.QuoteMeta(mod) + `(\s|,|\.|$)`)
 // from <mod> import ...  or  from <mod>.<sub> import ...
 fromRe := regexp.MustCompile(`^from\s+` + regexp.QuoteMeta(mod) + `(\s|\.)`)
 return importRe.MatchString(line) || fromRe.MatchString(line)
}

func checkJS(code string) AnalysisResult {
 var reasons []string
 for _, g := range jsForbiddenGlobals {
  // match as standalone identifier (word boundary)
  pat := regexp.MustCompile(`\b` + regexp.QuoteMeta(g) + `\b`)
  if pat.MatchString(code) {
   reasons = append(reasons, fmt.Sprintf("forbidden global: %s", g))
  }
 }
 for _, re := range jsForbiddenPatterns {
  if re.MatchString(code) {
   reasons = append(reasons, fmt.Sprintf("forbidden pattern: %s", re.String()))
  }
 }
 return AnalysisResult{Safe: len(reasons) == 0, Reasons: reasons}
}
```

- [ ] **Step 4: 运行测试**

```bash
go test ./internal/skill/... -run "TestPythonAnalyzer|TestJSAnalyzer|TestAnalyzer_" -v
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add internal/skill/analyzer.go internal/skill/analyzer_test.go
git commit -m "feat(skill): add StaticAnalyzer for Python and JS code"
```

---

### Task 3: Semaphore（全局+per-tenant 并发控制）

**Files:**

- Create: `internal/skill/semaphore.go`
- Create: `internal/skill/semaphore_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/skill/semaphore_test.go`：

```go
package skill

import (
 "context"
 "errors"
 "sync"
 "testing"
 "time"
)

func TestSemaphore_GlobalLimit(t *testing.T) {
 s := NewSemaphore(2, 10)
 ctx := context.Background()

 if err := s.Acquire(ctx, "t1"); err != nil {
  t.Fatal(err)
 }
 if err := s.Acquire(ctx, "t1"); err != nil {
  t.Fatal(err)
 }
 // third acquire should fail immediately
 ctxCancel, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
 defer cancel()
 err := s.Acquire(ctxCancel, "t2")
 if !errors.Is(err, ErrConcurrencyLimit) {
  t.Fatalf("expected ErrConcurrencyLimit, got %v", err)
 }
 s.Release("t1")
 s.Release("t1")
}

func TestSemaphore_PerTenantLimit(t *testing.T) {
 s := NewSemaphore(100, 2)
 ctx := context.Background()

 if err := s.Acquire(ctx, "tenant-a"); err != nil {
  t.Fatal(err)
 }
 if err := s.Acquire(ctx, "tenant-a"); err != nil {
  t.Fatal(err)
 }
 ctxCancel, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
 defer cancel()
 err := s.Acquire(ctxCancel, "tenant-a")
 if !errors.Is(err, ErrConcurrencyLimit) {
  t.Fatalf("expected ErrConcurrencyLimit, got %v", err)
 }
 // different tenant should still succeed
 if err2 := s.Acquire(ctx, "tenant-b"); err2 != nil {
  t.Fatalf("different tenant blocked: %v", err2)
 }
 s.Release("tenant-a")
 s.Release("tenant-a")
 s.Release("tenant-b")
}

func TestSemaphore_ReleaseUnblocksWaiter(t *testing.T) {
 s := NewSemaphore(1, 10)
 ctx := context.Background()

 if err := s.Acquire(ctx, "t1"); err != nil {
  t.Fatal(err)
 }
 var wg sync.WaitGroup
 wg.Add(1)
 go func() {
  defer wg.Done()
  waitCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
  defer cancel()
  _ = s.Acquire(waitCtx, "t1")
 }()
 time.Sleep(20 * time.Millisecond)
 s.Release("t1")
 wg.Wait()
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/skill/... -run TestSemaphore -v 2>&1 | head -20
```

- [ ] **Step 3: 实现 semaphore.go**

创建 `internal/skill/semaphore.go`：

```go
package skill

import (
 "context"
 "errors"
 "sync"
)

// ErrConcurrencyLimit is returned when global or per-tenant slot is exhausted.
var ErrConcurrencyLimit = errors.New("concurrency limit reached")

// Semaphore controls global and per-tenant concurrent code executions.
type Semaphore struct {
 global       chan struct{}
 perTenantMax int
 tenants      sync.Map // tenantID -> chan struct{}
}

// NewSemaphore creates a Semaphore with given global and per-tenant caps.
func NewSemaphore(globalMax, perTenantMax int) *Semaphore {
 return &Semaphore{
  global:       make(chan struct{}, globalMax),
  perTenantMax: perTenantMax,
 }
}

// Acquire takes one global slot and one per-tenant slot.
// Returns ErrConcurrencyLimit if either slot is full or ctx is cancelled.
func (s *Semaphore) Acquire(ctx context.Context, tenantID string) error {
 select {
 case s.global <- struct{}{}:
 case <-ctx.Done():
  return ErrConcurrencyLimit
 }
 tc := s.tenantChan(tenantID)
 select {
 case tc <- struct{}{}:
  return nil
 case <-ctx.Done():
  <-s.global // release global slot we already took
  return ErrConcurrencyLimit
 }
}

// Release frees one global slot and one per-tenant slot.
func (s *Semaphore) Release(tenantID string) {
 <-s.global
 if tc, ok := s.tenants.Load(tenantID); ok {
  <-tc.(chan struct{})
 }
}

func (s *Semaphore) tenantChan(tenantID string) chan struct{} {
 v, _ := s.tenants.LoadOrStore(tenantID, make(chan struct{}, s.perTenantMax))
 return v.(chan struct{})
}
```

- [ ] **Step 4: 运行测试**

```bash
go test ./internal/skill/... -run TestSemaphore -v -race
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add internal/skill/semaphore.go internal/skill/semaphore_test.go
git commit -m "feat(skill): add Semaphore for global+per-tenant concurrency control"
```

---

### Task 4: CodeExecutor（goja JS + subprocess Python）

**Files:**

- Create: `internal/skill/code_executor.go`
- Create: `internal/skill/code_executor_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/skill/code_executor_test.go`：

```go
package skill

import (
 "context"
 "strings"
 "testing"
 "time"

 "go.uber.org/zap"
)

func newTestExecutor(t *testing.T) *CodeExecutor {
 t.Helper()
 logger, _ := zap.NewDevelopment()
 sem := NewSemaphore(10, 5)
 return NewCodeExecutor(sem, logger, CodeExecutorConfig{
  DefaultTimeoutSec: 5,
  PythonMemoryMB:    64,
 })
}

func TestCodeExecutor_JSBasic(t *testing.T) {
 exec := newTestExecutor(t)
 code := `function process(inputData) { return { output: inputData.query.toUpperCase() }; }`
 input := map[string]interface{}{"query": "hello"}
 result, err := exec.Execute(context.Background(), "javascript", code, input, "test-tenant")
 if err != nil {
  t.Fatal(err)
 }
 m, ok := result.(map[string]interface{})
 if !ok {
  t.Fatalf("unexpected result type: %T", result)
 }
 if m["output"] != "HELLO" {
  t.Errorf("expected HELLO, got %v", m["output"])
 }
}

func TestCodeExecutor_JSTimeout(t *testing.T) {
 exec := newTestExecutor(t)
 code := `function process(inputData) { while(true){} return {}; }`
 ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
 defer cancel()
 _, err := exec.Execute(ctx, "javascript", code, map[string]interface{}{}, "test-tenant")
 if err == nil {
  t.Fatal("expected timeout error")
 }
}

func TestCodeExecutor_JSSyntaxError(t *testing.T) {
 exec := newTestExecutor(t)
 code := `function process( { return {}; }`
 _, err := exec.Execute(context.Background(), "javascript", code, map[string]interface{}{}, "test-tenant")
 if err == nil {
  t.Fatal("expected syntax error")
 }
}

func TestCodeExecutor_PythonBasic(t *testing.T) {
 exec := newTestExecutor(t)
 code := `
def process(input_data):
    return {"output": input_data.get("query", "").upper()}
`
 input := map[string]interface{}{"query": "hello"}
 result, err := exec.Execute(context.Background(), "python", code, input, "test-tenant")
 if err != nil {
  t.Fatalf("python exec failed: %v", err)
 }
 m, ok := result.(map[string]interface{})
 if !ok {
  t.Fatalf("unexpected type: %T", result)
 }
 if m["output"] != "HELLO" {
  t.Errorf("expected HELLO, got %v", m["output"])
 }
}

func TestCodeExecutor_PythonTimeout(t *testing.T) {
 exec := newTestExecutor(t)
 code := `
def process(input_data):
    import time
    time.sleep(60)
    return {}
`
 ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
 defer cancel()
 _, err := exec.Execute(ctx, "python", code, map[string]interface{}{}, "test-tenant")
 if err == nil {
  t.Fatal("expected timeout")
 }
}

func TestCodeExecutor_PythonRuntimeError(t *testing.T) {
 exec := newTestExecutor(t)
 code := `
def process(input_data):
    raise ValueError("boom")
`
 _, err := exec.Execute(context.Background(), "python", code, map[string]interface{}{}, "test-tenant")
 if err == nil || !strings.Contains(err.Error(), "boom") {
  t.Fatalf("expected 'boom' in error, got: %v", err)
 }
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/skill/... -run TestCodeExecutor -v 2>&1 | head -20
```

- [ ] **Step 3: 实现 code_executor.go**

创建 `internal/skill/code_executor.go`：

```go
package skill

import (
 "bytes"
 "context"
 "encoding/json"
 "fmt"
 "os/exec"
 "syscall"
 "time"

 "github.com/dop251/goja"
 "go.uber.org/zap"
)

// CodeExecutorConfig holds tunable limits.
type CodeExecutorConfig struct {
 DefaultTimeoutSec int
 PythonMemoryMB    int
}

// CodeExecutor executes JS (via goja) and Python (via subprocess) skills.
type CodeExecutor struct {
 sem    *Semaphore
 logger *zap.Logger
 cfg    CodeExecutorConfig
}

// NewCodeExecutor creates a CodeExecutor.
func NewCodeExecutor(sem *Semaphore, logger *zap.Logger, cfg CodeExecutorConfig) *CodeExecutor {
 if cfg.DefaultTimeoutSec <= 0 {
  cfg.DefaultTimeoutSec = 10
 }
 if cfg.PythonMemoryMB <= 0 {
  cfg.PythonMemoryMB = 128
 }
 return &CodeExecutor{sem: sem, logger: logger, cfg: cfg}
}

// Execute runs code in the given language with input data.
// tenantID is used for per-tenant concurrency tracking.
func (e *CodeExecutor) Execute(ctx context.Context, lang, code string, input interface{}, tenantID string) (interface{}, error) {
 // ensure deadline
 if _, ok := ctx.Deadline(); !ok {
  var cancel context.CancelFunc
  ctx, cancel = context.WithTimeout(ctx, time.Duration(e.cfg.DefaultTimeoutSec)*time.Second)
  defer cancel()
 }

 if err := e.sem.Acquire(ctx, tenantID); err != nil {
  return nil, ErrConcurrencyLimit
 }
 defer e.sem.Release(tenantID)

 switch lang {
 case "javascript":
  return e.runJS(ctx, code, input)
 case "python":
  return e.runPython(ctx, code, input)
 default:
  return nil, fmt.Errorf("unsupported language: %s", lang)
 }
}

// runJS executes JS code using goja. User code must define process(inputData).
func (e *CodeExecutor) runJS(ctx context.Context, code string, input interface{}) (interface{}, error) {
 vm := goja.New()

 // Disable dangerous globals
 for _, g := range []string{"process", "require", "global", "Buffer"} {
  _ = vm.Set(g, goja.Undefined())
 }
 // Redirect console.log to zap (no-op in production, safe)
 console := vm.NewObject()
 _ = console.Set("log", func(call goja.FunctionCall) goja.Value {
  e.logger.Debug("js console.log", zap.Any("args", call.Arguments))
  return goja.Undefined()
 })
 _ = vm.Set("console", console)

 // Interrupt on ctx done
 done := make(chan struct{})
 go func() {
  select {
  case <-ctx.Done():
   vm.Interrupt("timeout")
  case <-done:
  }
 }()
 defer close(done)

 // Inject input as global
 inputJSON, err := json.Marshal(input)
 if err != nil {
  return nil, fmt.Errorf("marshal input: %w", err)
 }
 script := fmt.Sprintf(`var __input = %s; %s; process(__input);`, string(inputJSON), code)

 val, err := vm.RunString(script)
 if err != nil {
  return nil, fmt.Errorf("js execution: %w", err)
 }

 return val.Export(), nil
}

// runPython executes Python code via subprocess with resource limits.
// User code must define def process(input_data): return dict.
func (e *CodeExecutor) runPython(ctx context.Context, code string, input interface{}) (interface{}, error) {
 inputJSON, err := json.Marshal(input)
 if err != nil {
  return nil, fmt.Errorf("marshal input: %w", err)
 }

 wrapper := fmt.Sprintf(`import sys, json
input_data = json.loads(sys.stdin.read())
%s
result = process(input_data)
print(json.dumps(result))
`, code)

 memBytes := uint64(e.cfg.PythonMemoryMB) * 1024 * 1024
 cmd := exec.CommandContext(ctx, "python3", "-c", wrapper)
 cmd.Stdin = bytes.NewReader(inputJSON)
 cmd.SysProcAttr = &syscall.SysProcAttr{
  Setpgid: true,
  // Resource limits via Pdeathsig ensures child dies with parent
  Pdeathsig: syscall.SIGKILL,
 }
 applyPrlimit(cmd, memBytes)

 var stdout, stderr bytes.Buffer
 cmd.Stdout = &stdout
 cmd.Stderr = &stderr

 if err := cmd.Run(); err != nil {
  errMsg := strings.TrimSpace(stderr.String())
  if errMsg == "" {
   errMsg = err.Error()
  }
  return nil, fmt.Errorf("python: %s", errMsg)
 }

 var result interface{}
 if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
  return nil, fmt.Errorf("parse python output: %w", err)
 }
 return result, nil
}
```

注意：`strings` 包漏了 import，`applyPrlimit` 需要单独文件（Linux only）。修正 imports 并创建 `internal/skill/prlimit_linux.go`：

```go
// internal/skill/prlimit_linux.go
//go:build linux

package skill

import (
 "os/exec"
 "syscall"
 "unsafe"
)

type rlimit struct {
 Cur uint64
 Max uint64
}

func applyPrlimit(cmd *exec.Cmd, memBytes uint64) {
 // RLIMIT_AS=9, RLIMIT_CPU=0, RLIMIT_NOFILE=7
 lim := rlimit{Cur: memBytes, Max: memBytes}
 _ = lim
 // Use SysProcAttr.Prlimit if available (Go 1.20+)
 cmd.SysProcAttr.Prlimit = []syscall.Rlimit{
  {Cur: memBytes, Max: memBytes}, // RLIMIT_AS = 9... set via prlimit after fork
 }
}
```

实际 Go 的 `syscall.SysProcAttr` 不直接支持 `Prlimit` 字段（那是 `unix` 包）。使用正确方式，将 `runPython` 中的资源限制改为 `ulimit` 前缀命令：

重写 `code_executor.go` 中 `runPython` 的 cmd 构建部分，并删除 `prlimit_linux.go`，改用 bash ulimit wrapper：

```go
// runPython via ulimit wrapper — no CGO, no syscall import needed
memKB := e.cfg.PythonMemoryMB * 1024
script := fmt.Sprintf(
    "ulimit -v %d -t 5 -n 16 2>/dev/null; python3 -c %q",
    memKB,
    wrapper,
)
cmd := exec.CommandContext(ctx, "bash", "-c", script)
```

但 `ulimit -v` 对 python3 内存限制在某些系统不可靠。最可靠的方案是 `prlimit` 命令（来自 util-linux）：

```go
// 使用 prlimit 命令包装 python3（util-linux 提供，Ubuntu/Debian 默认有）
memBytes := e.cfg.PythonMemoryMB * 1024 * 1024
args := []string{
    fmt.Sprintf("--as=%d", memBytes),
    fmt.Sprintf("--cpu=5"),
    "--nofile=16",
    "python3", "-c", wrapper,
}
cmd := exec.CommandContext(ctx, "prlimit", args...)
cmd.Stdin = bytes.NewReader(inputJSON)
cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
```

完整最终版 `code_executor.go`（包含正确 imports）见 Step 3 实际文件内容。

- [ ] **Step 3b: 写出最终完整 code_executor.go**

创建 `internal/skill/code_executor.go`（完整版）：

```go
package skill

import (
 "bytes"
 "context"
 "encoding/json"
 "fmt"
 "os/exec"
 "strings"
 "syscall"
 "time"

 "github.com/dop251/goja"
 "go.uber.org/zap"
)

// CodeExecutorConfig holds tunable limits for code execution.
type CodeExecutorConfig struct {
 DefaultTimeoutSec int
 PythonMemoryMB    int
}

// CodeExecutor executes JS (via goja) and Python (via prlimit+subprocess) skills.
type CodeExecutor struct {
 sem    *Semaphore
 logger *zap.Logger
 cfg    CodeExecutorConfig
}

// NewCodeExecutor creates a CodeExecutor with the given semaphore and config.
func NewCodeExecutor(sem *Semaphore, logger *zap.Logger, cfg CodeExecutorConfig) *CodeExecutor {
 if cfg.DefaultTimeoutSec <= 0 {
  cfg.DefaultTimeoutSec = 10
 }
 if cfg.PythonMemoryMB <= 0 {
  cfg.PythonMemoryMB = 128
 }
 return &CodeExecutor{sem: sem, logger: logger, cfg: cfg}
}

// Execute runs code with input. tenantID tracks per-tenant slot usage.
func (e *CodeExecutor) Execute(ctx context.Context, lang, code string, input interface{}, tenantID string) (interface{}, error) {
 if _, ok := ctx.Deadline(); !ok {
  var cancel context.CancelFunc
  ctx, cancel = context.WithTimeout(ctx, time.Duration(e.cfg.DefaultTimeoutSec)*time.Second)
  defer cancel()
 }

 if err := e.sem.Acquire(ctx, tenantID); err != nil {
  return nil, ErrConcurrencyLimit
 }
 defer e.sem.Release(tenantID)

 switch lang {
 case "javascript":
  return e.runJS(ctx, code, input)
 case "python":
  return e.runPython(ctx, code, input)
 default:
  return nil, fmt.Errorf("unsupported language: %s", lang)
 }
}

func (e *CodeExecutor) runJS(ctx context.Context, code string, input interface{}) (interface{}, error) {
 vm := goja.New()

 for _, g := range []string{"process", "require", "global", "Buffer"} {
  _ = vm.Set(g, goja.Undefined())
 }
 console := vm.NewObject()
 _ = console.Set("log", func(call goja.FunctionCall) goja.Value {
  e.logger.Debug("js console.log", zap.Any("args", call.Arguments))
  return goja.Undefined()
 })
 _ = vm.Set("console", console)

 done := make(chan struct{})
 go func() {
  select {
  case <-ctx.Done():
   vm.Interrupt("timeout")
  case <-done:
  }
 }()
 defer close(done)

 inputJSON, err := json.Marshal(input)
 if err != nil {
  return nil, fmt.Errorf("marshal input: %w", err)
 }
 script := fmt.Sprintf(`var __input = %s; %s; process(__input);`, string(inputJSON), code)

 val, err := vm.RunString(script)
 if err != nil {
  return nil, fmt.Errorf("js execution: %w", err)
 }
 return val.Export(), nil
}

func (e *CodeExecutor) runPython(ctx context.Context, code string, input interface{}) (interface{}, error) {
 inputJSON, err := json.Marshal(input)
 if err != nil {
  return nil, fmt.Errorf("marshal input: %w", err)
 }

 wrapper := fmt.Sprintf("import sys, json\ninput_data = json.loads(sys.stdin.read())\n%s\nprint(json.dumps(process(input_data)))\n", code)
 memBytes := e.cfg.PythonMemoryMB * 1024 * 1024

 // prlimit: limit virtual memory, CPU time, open file descriptors
 args := []string{
  fmt.Sprintf("--as=%d", memBytes),
  "--cpu=5",
  "--nofile=16",
  "python3", "-c", wrapper,
 }
 cmd := exec.CommandContext(ctx, "prlimit", args...)
 cmd.Stdin = bytes.NewReader(inputJSON)
 cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

 var stdout, stderr bytes.Buffer
 cmd.Stdout = &stdout
 cmd.Stderr = &stderr

 if err := cmd.Run(); err != nil {
  errMsg := strings.TrimSpace(stderr.String())
  if errMsg == "" {
   errMsg = err.Error()
  }
  return nil, fmt.Errorf("python: %s", errMsg)
 }

 var result interface{}
 if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
  return nil, fmt.Errorf("parse python output: %w", err)
 }
 return result, nil
}
```

- [ ] **Step 4: 运行测试**

```bash
go test ./internal/skill/... -run TestCodeExecutor -v -timeout 30s
```

Expected: JS tests PASS; Python tests PASS（需要 python3 和 prlimit 在 PATH 中）

- [ ] **Step 5: 编译检查**

```bash
go build ./internal/skill/...
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add internal/skill/code_executor.go internal/skill/code_executor_test.go
git commit -m "feat(skill): add CodeExecutor with goja JS and subprocess Python execution"
```

---

### Task 5: CodeSkill.Execute 委托给 CodeExecutor

**Files:**

- Modify: `internal/skill/code_skill.go`

- [ ] **Step 1: 修改 code_skill.go**

将 `internal/skill/code_skill.go` 替换为：

```go
package skill

import (
 "context"
 "fmt"

 "go.uber.org/zap"
)

// CodeSkill executes user-defined code via CodeExecutor.
type CodeSkill struct {
 *BaseSkill
 Code     string
 Language string
 executor *CodeExecutor
}

// NewCodeSkill creates a CodeSkill. executor may be nil (returns stub until injected).
func NewCodeSkill(id, name, description, code, language string) *CodeSkill {
 return &CodeSkill{
  BaseSkill: &BaseSkill{
   ID:          id,
   Name:        name,
   Description: description,
   Type:        "code",
  },
  Code:     code,
  Language: language,
 }
}

// WithExecutor injects the CodeExecutor dependency.
func (cs *CodeSkill) WithExecutor(e *CodeExecutor) *CodeSkill {
 cs.executor = e
 return cs
}

func (cs *CodeSkill) Execute(ctx context.Context, input interface{}) (interface{}, error) {
 inputMap, ok := input.(map[string]interface{})
 if !ok {
  return nil, fmt.Errorf("invalid input: expected map")
 }

 tenantID, _ := inputMap["__tenant_id"].(string)

 if cs.executor == nil {
  return map[string]interface{}{
   "code":     cs.Code,
   "language": cs.Language,
   "output":   "executor not configured",
  }, nil
 }

 return cs.executor.Execute(ctx, cs.Language, cs.Code, inputMap, tenantID)
}

// GetConfig implements configurable interface for skill response serialization.
func (cs *CodeSkill) GetConfig() map[string]any {
 return map[string]any{
  "language": cs.Language,
  "code":     cs.Code,
 }
}
```

注意：`zap` 不直接用于 CodeSkill，但 `CodeExecutor` 需要。先检查 code_skill.go 是否需要 zap import——不需要，移除。

实际最终版（无多余 import）：

```go
package skill

import (
 "context"
 "fmt"
)

type CodeSkill struct {
 *BaseSkill
 Code     string
 Language string
 executor *CodeExecutor
}

func NewCodeSkill(id, name, description, code, language string) *CodeSkill {
 return &CodeSkill{
  BaseSkill: &BaseSkill{
   ID:          id,
   Name:        name,
   Description: description,
   Type:        "code",
  },
  Code:     code,
  Language: language,
 }
}

// WithExecutor injects the shared CodeExecutor.
func (cs *CodeSkill) WithExecutor(e *CodeExecutor) *CodeSkill {
 cs.executor = e
 return cs
}

func (cs *CodeSkill) Execute(ctx context.Context, input interface{}) (interface{}, error) {
 inputMap, ok := input.(map[string]interface{})
 if !ok {
  return nil, fmt.Errorf("invalid input: expected map")
 }
 tenantID, _ := inputMap["__tenant_id"].(string)
 if cs.executor == nil {
  return map[string]interface{}{
   "language": cs.Language,
   "output":   "executor not configured",
  }, nil
 }
 return cs.executor.Execute(ctx, cs.Language, cs.Code, inputMap, tenantID)
}

func (cs *CodeSkill) GetConfig() map[string]any {
 return map[string]any{
  "language": cs.Language,
  "code":     cs.Code,
 }
}
```

- [ ] **Step 2: 编译**

```bash
go build ./internal/skill/...
```

- [ ] **Step 3: Commit**

```bash
git add internal/skill/code_skill.go
git commit -m "feat(skill): CodeSkill.Execute delegates to CodeExecutor"
```

---

### Task 6: 修改 api/model/request.go

**Files:**

- Modify: `api/model/request.go`

- [ ] **Step 1: 修改 request.go**

在 `api/model/request.go` 中将 `ErrorResponse` 替换，并添加运行相关结构体：

```go
package model

type CreateSkillRequest struct {
 Name        string `json:"name" binding:"required"`
 Description string `json:"description"`
 Type        string `json:"type" binding:"required,oneof=code llm http"`
 // code
 Code     string `json:"code"`
 Language string `json:"language"`
 // llm
 SystemPrompt string  `json:"systemPrompt"`
 Model        string  `json:"model"`
 Temperature  float32 `json:"temperature"`
 MaxTokens    int     `json:"maxTokens"`
 // http
 URL          string            `json:"url"`
 Method       string            `json:"method"`
 Headers      map[string]string `json:"headers"`
 BodyTemplate string            `json:"bodyTemplate"`
 TimeoutSec   int               `json:"timeoutSec"`
}

type SkillResponse struct {
 ID          string         `json:"id"`
 Name        string         `json:"name"`
 Description string         `json:"description"`
 Type        string         `json:"type"`
 Config      map[string]any `json:"config,omitempty"`
 CreatedAt   string         `json:"created_at"`
}

type ErrorResponse struct {
 Code           int      `json:"code"`
 Message        string   `json:"message"`
 AnalysisErrors []string `json:"analysis_errors,omitempty"`
}

type ExecuteSkillRequest struct {
 Input interface{} `json:"input"`
}

type ExecuteSkillResponse struct {
 Result interface{} `json:"result"`
 Error  string      `json:"error,omitempty"`
}

type RunSkillRequest struct {
 Input interface{} `json:"input"`
}

type RunSkillResponse struct {
 Output     interface{} `json:"output"`
 DurationMs int64       `json:"duration_ms"`
 Error      string      `json:"error,omitempty"`
}
```

- [ ] **Step 2: 编译**

```bash
go build ./api/...
```

- [ ] **Step 3: Commit**

```bash
git add api/model/request.go
git commit -m "feat(api): add AnalysisErrors to ErrorResponse; add RunSkillRequest/Response"
```

---

### Task 7: 修改 skill_handler.go（静态分析 + RunSkill）

**Files:**

- Modify: `api/handler/skill_handler.go`

- [ ] **Step 1: 修改 skill_handler.go**

完整替换 `api/handler/skill_handler.go`：

```go
package handler

import (
 "errors"
 "net/http"
 "time"

 "github.com/byteBuilderX/ClawHermes-AI-Go/api/model"
 "github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
 "github.com/byteBuilderX/ClawHermes-AI-Go/internal/orchestrator"
 "github.com/byteBuilderX/ClawHermes-AI-Go/internal/skill"
 "github.com/byteBuilderX/ClawHermes-AI-Go/pkg/tenantdb"
 "github.com/gin-gonic/gin"
 "github.com/google/uuid"
 "go.uber.org/zap"
)

type configurable interface {
 GetConfig() map[string]any
}

func buildSkillResponse(s skill.Skill, createdAt time.Time) model.SkillResponse {
 resp := model.SkillResponse{
  ID:          s.GetID(),
  Name:        s.GetName(),
  Description: s.GetDescription(),
  Type:        s.GetType(),
  CreatedAt:   createdAt.Format(time.RFC3339),
 }
 if c, ok := s.(configurable); ok {
  resp.Config = c.GetConfig()
 }
 return resp
}

type SkillHandler struct {
 registry *orchestrator.Registry
 logger   *zap.Logger
 gateway  *llmgateway.Gateway
 analyzer skill.StaticAnalyzer
 executor *skill.CodeExecutor
}

func NewSkillHandler(registry *orchestrator.Registry, logger *zap.Logger, gateway *llmgateway.Gateway, executor *skill.CodeExecutor) *SkillHandler {
 return &SkillHandler{
  registry: registry,
  logger:   logger,
  gateway:  gateway,
  analyzer: skill.NewStaticAnalyzer(),
  executor: executor,
 }
}

func (h *SkillHandler) CreateSkill(c *gin.Context) {
 var req model.CreateSkillRequest
 if err := c.ShouldBindJSON(&req); err != nil {
  c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: err.Error()})
  return
 }

 if req.Type == "code" {
  if result := h.analyzer.Check(req.Language, req.Code); !result.Safe {
   c.JSON(http.StatusBadRequest, model.ErrorResponse{
    Code:           http.StatusBadRequest,
    Message:        "code analysis failed",
    AnalysisErrors: result.Reasons,
   })
   return
  }
 }

 id := uuid.New().String()
 var s skill.Skill

 switch req.Type {
 case "code":
  cs := skill.NewCodeSkill(id, req.Name, req.Description, req.Code, req.Language)
  if h.executor != nil {
   cs.WithExecutor(h.executor)
  }
  s = cs
 case "llm":
  s = skill.NewLLMSkill(id, req.Name, req.Description, req.SystemPrompt, req.Model, req.Temperature, req.MaxTokens, h.gateway, h.logger)
 case "http":
  s = skill.NewHTTPSkill(id, req.Name, req.Description, req.URL, req.Method, req.Headers, req.BodyTemplate, req.TimeoutSec)
 default:
  c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "unsupported skill type"})
  return
 }

 h.registry.Register(c.Request.Context(), id, s)
 h.logger.Info("skill created", zap.String("id", id), zap.String("name", req.Name))

 createdAt, _ := h.registry.GetCreatedAt(id)
 c.JSON(http.StatusCreated, buildSkillResponse(s, createdAt))
}

func (h *SkillHandler) GetSkill(c *gin.Context) {
 id := c.Param("id")
 s, ok := h.registry.Get(id)
 if !ok {
  c.JSON(http.StatusNotFound, model.ErrorResponse{Code: http.StatusNotFound, Message: "skill not found"})
  return
 }
 createdAt, _ := h.registry.GetCreatedAt(id)
 c.JSON(http.StatusOK, buildSkillResponse(s, createdAt))
}

func (h *SkillHandler) GetAllSkills(c *gin.Context) {
 skills := h.registry.GetAll()
 responses := make([]model.SkillResponse, 0, len(skills))
 for _, s := range skills {
  createdAt, _ := h.registry.GetCreatedAt(s.GetID())
  responses = append(responses, buildSkillResponse(s, createdAt))
 }
 c.JSON(http.StatusOK, gin.H{"skills": responses})
}

func (h *SkillHandler) UpdateSkill(c *gin.Context) {
 id := c.Param("id")
 s, ok := h.registry.Get(id)
 if !ok {
  c.JSON(http.StatusNotFound, model.ErrorResponse{Code: http.StatusNotFound, Message: "skill not found"})
  return
 }

 var req model.CreateSkillRequest
 if err := c.ShouldBindJSON(&req); err != nil {
  c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: err.Error()})
  return
 }

 if s.GetType() == "code" {
  if result := h.analyzer.Check(req.Language, req.Code); !result.Safe {
   c.JSON(http.StatusBadRequest, model.ErrorResponse{
    Code:           http.StatusBadRequest,
    Message:        "code analysis failed",
    AnalysisErrors: result.Reasons,
   })
   return
  }
 }

 switch s.GetType() {
 case "code":
  cs, ok := s.(*skill.CodeSkill)
  if !ok {
   c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "type mismatch"})
   return
  }
  cs.Name = req.Name
  cs.Description = req.Description
  cs.Code = req.Code
  cs.Language = req.Language
 case "llm":
  ls, ok := s.(*skill.LLMSkill)
  if !ok {
   c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "type mismatch"})
   return
  }
  ls.Name = req.Name
  ls.Description = req.Description
  ls.SystemPrompt = req.SystemPrompt
  ls.Model = req.Model
  ls.Temperature = req.Temperature
  ls.MaxTokens = req.MaxTokens
 case "http":
  hs, ok := s.(*skill.HTTPSkill)
  if !ok {
   c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "type mismatch"})
   return
  }
  hs.Name = req.Name
  hs.Description = req.Description
  hs.URL = req.URL
  hs.Method = req.Method
  hs.Headers = req.Headers
  hs.BodyTemplate = req.BodyTemplate
  hs.TimeoutSec = req.TimeoutSec
 default:
  c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "unsupported skill type"})
  return
 }

 h.registry.Register(c.Request.Context(), id, s)
 h.logger.Info("skill updated", zap.String("id", id))
 createdAt, _ := h.registry.GetCreatedAt(id)
 c.JSON(http.StatusOK, buildSkillResponse(s, createdAt))
}

func (h *SkillHandler) DeleteSkill(c *gin.Context) {
 id := c.Param("id")
 if err := h.registry.Remove(c.Request.Context(), id); err != nil {
  c.JSON(http.StatusNotFound, model.ErrorResponse{Code: http.StatusNotFound, Message: "skill not found"})
  return
 }
 h.logger.Info("skill deleted", zap.String("id", id))
 c.JSON(http.StatusOK, gin.H{"message": "skill deleted successfully"})
}

func (h *SkillHandler) RunSkill(c *gin.Context) {
 id := c.Param("id")
 s, ok := h.registry.Get(id)
 if !ok {
  c.JSON(http.StatusNotFound, model.ErrorResponse{Code: http.StatusNotFound, Message: "skill not found"})
  return
 }

 cs, ok := s.(*skill.CodeSkill)
 if !ok {
  c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "skill is not a code skill"})
  return
 }

 var req model.RunSkillRequest
 if err := c.ShouldBindJSON(&req); err != nil {
  c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: err.Error()})
  return
 }

 input, ok := req.Input.(map[string]interface{})
 if !ok {
  input = map[string]interface{}{}
 }

 // inject tenant ID for per-tenant concurrency tracking
 tenantID, _ := tenantdb.FromContext(c.Request.Context())
 input["__tenant_id"] = tenantID

 start := time.Now()
 result, err := cs.Execute(c.Request.Context(), input)
 durationMs := time.Since(start).Milliseconds()

 if err != nil {
  if errors.Is(err, skill.ErrConcurrencyLimit) {
   c.JSON(http.StatusTooManyRequests, model.ErrorResponse{
    Code:    http.StatusTooManyRequests,
    Message: "concurrency limit reached, try again later",
   })
   return
  }
  c.JSON(http.StatusInternalServerError, model.RunSkillResponse{
   DurationMs: durationMs,
   Error:      err.Error(),
  })
  return
 }

 c.JSON(http.StatusOK, model.RunSkillResponse{
  Output:     result,
  DurationMs: durationMs,
 })
}
```

- [ ] **Step 2: 编译**

```bash
go build ./api/...
```

如果 `tenantdb.FromContext` 签名不对，检查：

```bash
grep -n "func FromContext" pkg/tenantdb/*.go
```

调整调用方式匹配实际签名。

- [ ] **Step 3: Commit**

```bash
git add api/handler/skill_handler.go
git commit -m "feat(handler): add static analysis gate in CreateSkill/UpdateSkill; add RunSkill handler"
```

---

### Task 8: 修改 router.go 和 main.go（注入 CodeExecutor）

**Files:**

- Modify: `api/router.go`
- Modify: `cmd/server/main.go`（如需要）

- [ ] **Step 1: 修改 router.go**

在 `api/router.go` 的 `skillHandler` 初始化处，增加 `CodeExecutor` 构建并传入：

找到第 169 行：

```go
skillHandler := handler.NewSkillHandler(registry, logger, gateway)
```

替换为（在其之前增加 executor 构建）：

```go
codeExecCfg := skill.CodeExecutorConfig{
    DefaultTimeoutSec: cfg.CodeExecutor.DefaultTimeoutSec,
    PythonMemoryMB:    cfg.CodeExecutor.PythonMemoryMB,
}
if codeExecCfg.DefaultTimeoutSec <= 0 {
    codeExecCfg.DefaultTimeoutSec = 10
}
if codeExecCfg.PythonMemoryMB <= 0 {
    codeExecCfg.PythonMemoryMB = 128
}
globalMax := cfg.CodeExecutor.MaxConcurrent
if globalMax <= 0 {
    globalMax = 10
}
perTenantMax := cfg.CodeExecutor.PerTenantMax
if perTenantMax <= 0 {
    perTenantMax = 3
}
codeSemaphore := skill.NewSemaphore(globalMax, perTenantMax)
codeExecutor := skill.NewCodeExecutor(codeSemaphore, logger, codeExecCfg)
skillHandler := handler.NewSkillHandler(registry, logger, gateway, codeExecutor)
```

在 skills 路由组增加 run 路由（在 `skills.DELETE` 之后）：

```go
skills.POST("/:id/run", requireActive, skillHandler.RunSkill)
```

- [ ] **Step 2: 检查 config.CodeExecutor 字段**

```bash
grep -n "CodeExecutor" internal/config/*.go
```

如果 `config.Config` 没有 `CodeExecutor` 字段，在 config 文件中添加：

```go
type CodeExecutorConfig struct {
    MaxConcurrent     int `mapstructure:"max_concurrent"`
    PerTenantMax      int `mapstructure:"per_tenant_max"`
    DefaultTimeoutSec int `mapstructure:"default_timeout_sec"`
    PythonMemoryMB    int `mapstructure:"python_memory_mb"`
}

// 在 Config struct 中添加：
CodeExecutor CodeExecutorConfig `mapstructure:"code_executor"`
```

- [ ] **Step 3: 编译**

```bash
go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add api/router.go internal/config/
git commit -m "feat(router): add POST /skills/:id/run; wire CodeExecutor with config"
```

---

### Task 9: 前端 CreateSkillPage.jsx

**Files:**

- Modify: `web/src/pages/CreateSkillPage.jsx`

- [ ] **Step 1: 修改 CreateSkillPage.jsx**

做以下三处修改：

**1. 删除 CODE_EXAMPLES 中的 go 条目**（第 47-50 行）：

```js
// 删除：
  go: `func process(inputData map[string]interface{}) map[string]interface{} {
    query, _ := inputData["query"].(string)
    return map[string]interface{}{"output": strings.ToUpper(query)}
}`,
```

**2. 语言选择只保留 python 和 javascript**（第 153-158 行）：

```jsx
<Form.Item label="编程语言" name="language" rules={[{ required: true }]}>
  <Select>
    <Option value="python">Python</Option>
    <Option value="javascript">JavaScript</Option>
  </Select>
</Form.Item>
```

**3. 修改 onFinish 错误处理**，在 catch 块中展示 analysis_errors（第 98-101 行）：

```jsx
    } catch (err) {
      if (err.response?.status !== 403) {
        const data = err.response?.data;
        if (data?.analysis_errors?.length > 0) {
          message.error(
            <span>
              代码安全检查未通过：
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                {data.analysis_errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </span>,
            8
          );
        } else {
          message.error(data?.message || data?.error || '创建失败');
        }
      }
    }
```

完整修改后的 onFinish：

```jsx
  const onFinish = async (values) => {
    if (values.type === 'http' && values.headersJson) {
      try {
        values.headers = JSON.parse(values.headersJson);
      } catch {
        message.error('请求头 JSON 格式有误');
        return;
      }
      delete values.headersJson;
    }
    setLoading(true);
    try {
      await createSkill(values);
      message.success(`技能 "${values.name}" 创建成功`);
      navigate('/skills');
    } catch (err) {
      if (err.response?.status !== 403) {
        const data = err.response?.data;
        if (data?.analysis_errors?.length > 0) {
          message.error(
            <span>
              代码安全检查未通过：
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                {data.analysis_errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </span>,
            8
          );
        } else {
          message.error(data?.message || data?.error || '创建失败');
        }
      }
    } finally {
      setLoading(false);
    }
  };
```

- [ ] **Step 2: 前端编译检查**

```bash
cd web && npm run build 2>&1 | tail -10
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/CreateSkillPage.jsx
git commit -m "feat(web): remove go/other language options; show analysis_errors on create failure"
```

---

### Task 10: 前端 SkillsListPage.jsx（语言标签）

**Files:**

- Modify: `web/src/pages/SkillsListPage.jsx`

- [ ] **Step 1: 修改 SkillCard 组件**

在 `SkillCard` 组件（第 23-70 行）中，找到类型 Tag 所在位置（第 40-42 行）：

```jsx
<Tag style={{ border: 'none', borderRadius: 6, fontSize: 11, background: meta.bg, color: meta.color, fontWeight: 500 }}>
  {meta.label}
</Tag>
```

替换为：

```jsx
<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
  <Tag style={{ border: 'none', borderRadius: 6, fontSize: 11, background: meta.bg, color: meta.color, fontWeight: 500, margin: 0 }}>
    {meta.label}
  </Tag>
  {skill.type === 'code' && skill.config?.language && (
    <Tag style={{ border: 'none', borderRadius: 6, fontSize: 10, background: '#f0f0f0', color: '#595959', fontWeight: 400, margin: 0 }}>
      {skill.config.language === 'javascript' ? 'JS' : skill.config.language.toUpperCase()}
    </Tag>
  )}
</div>
```

- [ ] **Step 2: 前端编译检查**

```bash
cd web && npm run build 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/SkillsListPage.jsx
git commit -m "feat(web): show language tag on code skill cards"
```

---

### Task 11: 集成验证

- [ ] **Step 1: 完整后端测试**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go test -v -race -timeout 60s ./internal/skill/... ./api/...
```

Expected: 全部 PASS（Python 测试需要 `python3` 和 `prlimit` 在 PATH）

- [ ] **Step 2: 完整前端构建**

```bash
cd web && npm run lint && npm run build
```

- [ ] **Step 3: 最终 commit（如有遗漏文件）**

```bash
git status
# 确认无遗漏
```

---

## 自查

**Spec coverage:**

- [x] StaticAnalyzer — Task 2
- [x] Semaphore 全局+per-tenant — Task 3
- [x] goja JS 执行 — Task 4
- [x] Python subprocess + prlimit — Task 4
- [x] CodeSkill.Execute 委托 — Task 5
- [x] CreateSkill 静态分析门 — Task 7
- [x] UpdateSkill 静态分析门 — Task 7
- [x] POST /skills/:id/run — Task 7 + 8
- [x] 429 ErrConcurrencyLimit — Task 7
- [x] analysis_errors 响应 — Task 6 + 7
- [x] 前端语言选项 python/js only — Task 9
- [x] 前端 analysis_errors 展示 — Task 9
- [x] 前端语言标签 — Task 10
- [x] config 注入（CodeExecutor 从 cfg 读参数）— Task 8
