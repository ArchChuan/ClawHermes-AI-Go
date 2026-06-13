# 租户级 LLM API Key 配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持每个租户配置自己的 LLM API key，加密存入 settings JSONB，agent 执行时动态加载并缓存 5 分钟。

**Architecture:** AES-256-GCM 加密，密钥由 JWTPrivateKeyPEM SHA-256 派生；API key 存入 `public.tenants.settings["llm_api_keys"]`；`AgentHandler.ExecuteAgent` 执行前查缓存/DB，构造租户专属 Gateway；UpdateSettings 成功后主动失效缓存。

**Tech Stack:** Go 1.22, `crypto/aes`+`crypto/cipher`(标准库), `sync.Mutex`, pgxpool, React 18 + Ant Design 5.2

---

## 文件清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `pkg/crypto/aes.go` | 新增 | DeriveAESKey / Encrypt / Decrypt |
| `pkg/crypto/aes_test.go` | 新增 | 单元测试 |
| `internal/llmgateway/tenant_cache.go` | 新增 | TenantGatewayCache（Get/Set/Invalidate） |
| `internal/llmgateway/tenant_cache_test.go` | 新增 | 缓存单元测试 |
| `api/handler/tenant_handler.go` | 修改 | 注入 aesKey+cache；GetSettings 脱敏；UpdateSettings 加密+权限+失效 |
| `api/handler/agent_handler.go` | 修改 | 注入 db+aesKey+cache；ExecuteAgent 动态加载 Gateway |
| `api/router.go` | 修改 | 派生 aesKey，构造 cache，注入两个 handler |
| `web/src/pages/tenant/SettingsPage.jsx` | 修改 | 新增 API Key Card，加载脱敏值，按 provider 独立保存 |

---

## Task 1: pkg/crypto — AES-256-GCM 加密工具

**Files:**

- Create: `pkg/crypto/aes.go`
- Create: `pkg/crypto/aes_test.go`

- [ ] **Step 1: 写失败测试**

新建 `pkg/crypto/aes_test.go`：

```go
package crypto_test

import (
 "testing"

 "github.com/byteBuilderX/ClawHermes-AI-Go/pkg/crypto"
)

func TestEncryptDecryptRoundtrip(t *testing.T) {
 key := crypto.DeriveAESKey("test-pem-key")
 plaintext := "sk-abc123secretkey"

 ciphertext, err := crypto.Encrypt(key, plaintext)
 if err != nil {
  t.Fatalf("Encrypt failed: %v", err)
 }
 if ciphertext == plaintext {
  t.Fatal("ciphertext should differ from plaintext")
 }

 got, err := crypto.Decrypt(key, ciphertext)
 if err != nil {
  t.Fatalf("Decrypt failed: %v", err)
 }
 if got != plaintext {
  t.Fatalf("want %q, got %q", plaintext, got)
 }
}

func TestEncryptNonDeterministic(t *testing.T) {
 key := crypto.DeriveAESKey("test-pem-key")
 c1, _ := crypto.Encrypt(key, "same")
 c2, _ := crypto.Encrypt(key, "same")
 if c1 == c2 {
  t.Fatal("two encryptions of same plaintext should produce different ciphertext (random nonce)")
 }
}

func TestDecryptWrongKey(t *testing.T) {
 key1 := crypto.DeriveAESKey("key-one")
 key2 := crypto.DeriveAESKey("key-two")
 ct, _ := crypto.Encrypt(key1, "secret")
 if _, err := crypto.Decrypt(key2, ct); err == nil {
  t.Fatal("expected error when decrypting with wrong key")
 }
}

func TestDecryptTamperedCiphertext(t *testing.T) {
 key := crypto.DeriveAESKey("test-pem-key")
 ct, _ := crypto.Encrypt(key, "secret")
 // flip last byte
 b := []byte(ct)
 b[len(b)-1] ^= 0xFF
 if _, err := crypto.Decrypt(key, string(b)); err == nil {
  t.Fatal("expected error on tampered ciphertext")
 }
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go test ./pkg/crypto/... -v
```

预期：`cannot find package` 或 `undefined: crypto.DeriveAESKey`

- [ ] **Step 3: 实现 pkg/crypto/aes.go**

新建 `pkg/crypto/aes.go`：

```go
package crypto

import (
 "crypto/aes"
 "crypto/cipher"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "fmt"
 "io"
)

// DeriveAESKey derives a 32-byte AES-256 key from a PEM string via SHA-256.
func DeriveAESKey(jwtPrivateKeyPEM string) [32]byte {
 return sha256.Sum256([]byte(jwtPrivateKeyPEM))
}

// Encrypt encrypts plaintext with AES-256-GCM. Returns base64(nonce || ciphertext || tag).
func Encrypt(key [32]byte, plaintext string) (string, error) {
 block, err := aes.NewCipher(key[:])
 if err != nil {
  return "", fmt.Errorf("crypto: new cipher: %w", err)
 }
 gcm, err := cipher.NewGCM(block)
 if err != nil {
  return "", fmt.Errorf("crypto: new gcm: %w", err)
 }
 nonce := make([]byte, gcm.NonceSize())
 if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
  return "", fmt.Errorf("crypto: nonce: %w", err)
 }
 sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
 return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt decrypts a base64-encoded AES-256-GCM ciphertext produced by Encrypt.
func Decrypt(key [32]byte, encoded string) (string, error) {
 data, err := base64.StdEncoding.DecodeString(encoded)
 if err != nil {
  return "", fmt.Errorf("crypto: base64 decode: %w", err)
 }
 block, err := aes.NewCipher(key[:])
 if err != nil {
  return "", fmt.Errorf("crypto: new cipher: %w", err)
 }
 gcm, err := cipher.NewGCM(block)
 if err != nil {
  return "", fmt.Errorf("crypto: new gcm: %w", err)
 }
 nonceSize := gcm.NonceSize()
 if len(data) < nonceSize {
  return "", fmt.Errorf("crypto: ciphertext too short")
 }
 plaintext, err := gcm.Open(nil, data[:nonceSize], data[nonceSize:], nil)
 if err != nil {
  return "", fmt.Errorf("crypto: decrypt: %w", err)
 }
 return string(plaintext), nil
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
go test ./pkg/crypto/... -v -race
```

预期：4 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/crypto/aes.go pkg/crypto/aes_test.go
git commit -m "feat(crypto): add AES-256-GCM encrypt/decrypt with key derivation"
```

---

## Task 2: TenantGatewayCache — 5min TTL 内存缓存

**Files:**

- Create: `internal/llmgateway/tenant_cache.go`
- Create: `internal/llmgateway/tenant_cache_test.go`

- [ ] **Step 1: 写失败测试**

新建 `internal/llmgateway/tenant_cache_test.go`：

```go
package llmgateway_test

import (
 "testing"
 "time"

 "github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
)

func TestTenantGatewayCache_SetAndGet(t *testing.T) {
 cache := llmgateway.NewTenantGatewayCache()
 gw := llmgateway.NewGateway()

 cache.Set("tenant-1", gw, 5*time.Minute)

 got, ok := cache.Get("tenant-1")
 if !ok {
  t.Fatal("expected cache hit")
 }
 if got != gw {
  t.Fatal("expected same gateway pointer")
 }
}

func TestTenantGatewayCache_Miss(t *testing.T) {
 cache := llmgateway.NewTenantGatewayCache()
 _, ok := cache.Get("nonexistent")
 if ok {
  t.Fatal("expected cache miss")
 }
}

func TestTenantGatewayCache_Expiry(t *testing.T) {
 cache := llmgateway.NewTenantGatewayCache()
 gw := llmgateway.NewGateway()

 cache.Set("tenant-1", gw, 10*time.Millisecond)
 time.Sleep(20 * time.Millisecond)

 _, ok := cache.Get("tenant-1")
 if ok {
  t.Fatal("expected cache miss after expiry")
 }
}

func TestTenantGatewayCache_Invalidate(t *testing.T) {
 cache := llmgateway.NewTenantGatewayCache()
 gw := llmgateway.NewGateway()

 cache.Set("tenant-1", gw, 5*time.Minute)
 cache.Invalidate("tenant-1")

 _, ok := cache.Get("tenant-1")
 if ok {
  t.Fatal("expected cache miss after invalidate")
 }
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
go test ./internal/llmgateway/... -run TestTenantGatewayCache -v
```

预期：`undefined: llmgateway.NewTenantGatewayCache`

- [ ] **Step 3: 实现 tenant_cache.go**

新建 `internal/llmgateway/tenant_cache.go`：

```go
package llmgateway

import (
 "sync"
 "time"
)

// TenantGatewayCache is a TTL-based in-memory cache mapping tenantID → *Gateway.
type TenantGatewayCache struct {
 mu      sync.Mutex
 entries map[string]*cacheEntry
}

type cacheEntry struct {
 gateway   *Gateway
 expiresAt time.Time
}

// NewTenantGatewayCache returns an initialized cache.
func NewTenantGatewayCache() *TenantGatewayCache {
 return &TenantGatewayCache{
  entries: make(map[string]*cacheEntry),
 }
}

// Get returns the cached Gateway for tenantID, or (nil, false) on miss/expiry.
func (c *TenantGatewayCache) Get(tenantID string) (*Gateway, bool) {
 c.mu.Lock()
 defer c.mu.Unlock()
 e, ok := c.entries[tenantID]
 if !ok {
  return nil, false
 }
 if time.Now().After(e.expiresAt) {
  delete(c.entries, tenantID)
  return nil, false
 }
 return e.gateway, true
}

// Set stores a Gateway with the given TTL.
func (c *TenantGatewayCache) Set(tenantID string, gw *Gateway, ttl time.Duration) {
 c.mu.Lock()
 defer c.mu.Unlock()
 c.entries[tenantID] = &cacheEntry{gateway: gw, expiresAt: time.Now().Add(ttl)}
}

// Invalidate removes the cached entry for tenantID immediately.
func (c *TenantGatewayCache) Invalidate(tenantID string) {
 c.mu.Lock()
 defer c.mu.Unlock()
 delete(c.entries, tenantID)
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
go test ./internal/llmgateway/... -run TestTenantGatewayCache -v -race
```

预期：4 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add internal/llmgateway/tenant_cache.go internal/llmgateway/tenant_cache_test.go
git commit -m "feat(llmgateway): add TenantGatewayCache with TTL and invalidation"
```

---

## Task 3: TenantHandler — 加密存储 + 脱敏读取 + 权限控制

**Files:**

- Modify: `api/handler/tenant_handler.go`

**背景：** 当前 `TenantHandler` 只有 `db`、`logger`、`frontendURL` 三个字段。需要新增 `aesKey [32]byte` 和 `cache *llmgateway.TenantGatewayCache`。`UpdateSettings` 整体替换 JSONB，需先读取再 merge，防止覆盖其他字段。

- [ ] **Step 1: 写失败测试**

新建 `api/handler/tenant_handler_settings_test.go`（仅覆盖 settings 相关逻辑）：

```go
package handler_test

import (
 "testing"

 "github.com/byteBuilderX/ClawHermes-AI-Go/pkg/crypto"
)

func TestMaskAPIKey(t *testing.T) {
 cases := []struct {
  input string
  want  string
 }{
  {"", ""},
  {"abc", "****"},
  {"abcd", "****"},
  {"abcde", "****e"},
  {"sk-abc1234567", "****4567"},
 }
 for _, tc := range cases {
  got := maskAPIKey(tc.input)
  if got != tc.want {
   t.Errorf("maskAPIKey(%q) = %q, want %q", tc.input, got, tc.want)
  }
 }
}

func TestEncryptDecryptSettingsRoundtrip(t *testing.T) {
 key := crypto.DeriveAESKey("test-jwt-pem")
 original := "sk-realkey123"
 enc, err := crypto.Encrypt(key, original)
 if err != nil {
  t.Fatalf("encrypt: %v", err)
 }
 dec, err := crypto.Decrypt(key, enc)
 if err != nil {
  t.Fatalf("decrypt: %v", err)
 }
 if dec != original {
  t.Fatalf("want %q got %q", original, dec)
 }
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
go test ./api/handler/... -run "TestMaskAPIKey|TestEncryptDecryptSettingsRoundtrip" -v
```

预期：`undefined: maskAPIKey`

- [ ] **Step 3: 修改 TenantHandler 结构体和构造函数**

在 `api/handler/tenant_handler.go` 顶部 import 中增加：

```go
"github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
"github.com/byteBuilderX/ClawHermes-AI-Go/pkg/crypto"
```

将 `TenantHandler` struct 替换为：

```go
type TenantHandler struct {
 db          PgxPool
 logger      *zap.Logger
 frontendURL string
 aesKey      [32]byte
 cache       *llmgateway.TenantGatewayCache
}
```

将 `NewTenantHandler` 替换为：

```go
func NewTenantHandler(db PgxPool, logger *zap.Logger, frontendURL string, aesKey [32]byte, cache *llmgateway.TenantGatewayCache) *TenantHandler {
 return &TenantHandler{db: db, logger: logger, frontendURL: frontendURL, aesKey: aesKey, cache: cache}
}
```

在文件末尾新增 helper（在 `ListUserTenants` 之后）：

```go
// maskAPIKey returns a masked version of an API key showing only the last 4 chars.
func maskAPIKey(key string) string {
 if key == "" {
  return ""
 }
 if len(key) <= 4 {
  return "****"
 }
 return "****" + key[len(key)-4:]
}
```

- [ ] **Step 4: 修改 GetSettings — 脱敏 llm_api_keys**

将 `GetSettings` 中组装 response 之前加入脱敏逻辑，把原来的：

```go
c.JSON(http.StatusOK, model.SettingsResponse{TenantID: tenantID, TenantName: tenantName, Settings: settings})
```

替换为：

```go
if apiKeys, ok := settings["llm_api_keys"].(map[string]interface{}); ok {
    masked := make(map[string]interface{}, len(apiKeys))
    for provider, val := range apiKeys {
        if s, ok := val.(string); ok && s != "" {
            decrypted, err := crypto.Decrypt(h.aesKey, s)
            if err == nil {
                masked[provider] = maskAPIKey(decrypted)
            } else {
                masked[provider] = ""
            }
        } else {
            masked[provider] = ""
        }
    }
    settings["llm_api_keys"] = masked
}
c.JSON(http.StatusOK, model.SettingsResponse{TenantID: tenantID, TenantName: tenantName, Settings: settings})
```

- [ ] **Step 5: 修改 UpdateSettings — 权限控制 + 加密 + merge + 缓存失效**

将 `UpdateSettings` 整体替换为：

```go
// UpdateSettings PATCH /tenant/settings
func (h *TenantHandler) UpdateSettings(c *gin.Context) {
    tenantID, ok := tenantIDFromCtx(c)
    if !ok {
        c.JSON(http.StatusUnauthorized, model.ErrorResponse{Code: 401, Message: "tenant_id missing"})
        return
    }

    // Only owner/admin may write settings
    roleVal, _ := c.Get("auth.role")
    roleStr, _ := roleVal.(string)
    if roleStr != "admin" && roleStr != "owner" {
        c.JSON(http.StatusForbidden, model.ErrorResponse{Code: 403, Message: "admin or owner role required"})
        return
    }

    var req model.UpdateSettingsRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: 400, Message: err.Error()})
        return
    }

    if req.Name != "" {
        tag, err := h.db.Exec(c.Request.Context(),
            "UPDATE public.tenants SET name=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL",
            req.Name, tenantID)
        if err != nil {
            h.logger.Error("update tenant name failed", zap.Error(err))
            c.JSON(http.StatusInternalServerError, model.ErrorResponse{Code: 500, Message: "update failed"})
            return
        }
        if tag.RowsAffected() == 0 {
            c.JSON(http.StatusNotFound, model.ErrorResponse{Code: 404, Message: "tenant not found"})
            return
        }
    }

    if req.Settings != nil {
        // Read existing settings to merge (avoid overwriting unrelated keys)
        var existingJSON []byte
        _ = h.db.QueryRow(c.Request.Context(),
            "SELECT settings FROM public.tenants WHERE id=$1 AND deleted_at IS NULL", tenantID,
        ).Scan(&existingJSON)

        merged := map[string]interface{}{}
        if len(existingJSON) > 0 {
            _ = json.Unmarshal(existingJSON, &merged)
        }

        // Encrypt llm_api_keys values before merging
        if apiKeys, ok := req.Settings["llm_api_keys"].(map[string]interface{}); ok {
            encrypted := make(map[string]interface{}, len(apiKeys))
            for provider, val := range apiKeys {
                plaintext, ok := val.(string)
                if !ok || plaintext == "" {
                    continue
                }
                enc, err := crypto.Encrypt(h.aesKey, plaintext)
                if err != nil {
                    h.logger.Error("encrypt api key failed", zap.String("provider", provider), zap.Error(err))
                    c.JSON(http.StatusInternalServerError, model.ErrorResponse{Code: 500, Message: "encryption failed"})
                    return
                }
                encrypted[provider] = enc
            }
            // Merge encrypted keys into existing llm_api_keys
            existing, _ := merged["llm_api_keys"].(map[string]interface{})
            if existing == nil {
                existing = map[string]interface{}{}
            }
            for k, v := range encrypted {
                existing[k] = v
            }
            merged["llm_api_keys"] = existing
        }

        // Merge remaining non-llm_api_keys settings
        for k, v := range req.Settings {
            if k == "llm_api_keys" {
                continue
            }
            merged[k] = v
        }

        settingsJSON, err := json.Marshal(merged)
        if err != nil {
            c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: 400, Message: "invalid settings"})
            return
        }
        if _, err := h.db.Exec(c.Request.Context(),
            "UPDATE public.tenants SET settings=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL",
            settingsJSON, tenantID); err != nil {
            h.logger.Error("update settings failed", zap.Error(err))
            c.JSON(http.StatusInternalServerError, model.ErrorResponse{Code: 500, Message: "update failed"})
            return
        }

        // Invalidate gateway cache so next execute picks up new key immediately
        if h.cache != nil {
            h.cache.Invalidate(tenantID)
        }
    }

    c.JSON(http.StatusOK, gin.H{"message": "settings updated"})
}
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
go test ./api/handler/... -run "TestMaskAPIKey|TestEncryptDecryptSettingsRoundtrip" -v
go build ./...
```

预期：测试 PASS，build 无错误

- [ ] **Step 7: Commit**

```bash
git add api/handler/tenant_handler.go api/handler/tenant_handler_settings_test.go
git commit -m "feat(tenant): encrypt llm_api_keys in UpdateSettings, mask in GetSettings, add owner/admin guard"
```

---

## Task 4: AgentHandler — ExecuteAgent 动态加载租户 Gateway

**Files:**

- Modify: `api/handler/agent_handler.go`

**背景：** 当前 `AgentHandler` 持有共享 `*llmgateway.Gateway`。需新增 `db PgxPool`、`aesKey [32]byte`、`gatewayCache *llmgateway.TenantGatewayCache` 三个字段，在 `ExecuteAgent` 中读取租户 settings，解密构造租户专属 Gateway，5min 缓存。

- [ ] **Step 1: 修改 AgentHandler 结构体和构造函数**

将 `AgentHandler` struct 替换为：

```go
type AgentHandler struct {
 agentRegistry  *agent.Registry
 logger         *zap.Logger
 gateway        *llmgateway.Gateway
 metrics        observability.MetricsProvider
 executionStore *agent.ExecutionStore
 db             PgxPool
 aesKey         [32]byte
 gatewayCache   *llmgateway.TenantGatewayCache
}
```

将 `NewAgentHandler` 替换为：

```go
func NewAgentHandler(
 agentRegistry *agent.Registry,
 logger *zap.Logger,
 gateway *llmgateway.Gateway,
 metrics observability.MetricsProvider,
 execStore *agent.ExecutionStore,
 db PgxPool,
 aesKey [32]byte,
 gatewayCache *llmgateway.TenantGatewayCache,
) *AgentHandler {
 return &AgentHandler{
  agentRegistry:  agentRegistry,
  logger:         logger,
  gateway:        gateway,
  metrics:        metrics,
  executionStore: execStore,
  db:             db,
  aesKey:         aesKey,
  gatewayCache:   gatewayCache,
 }
}
```

- [ ] **Step 2: 新增 resolveTenantGateway helper**

在 `agent_handler.go` 末尾新增（在最后一个函数后）：

```go
// resolveTenantGateway returns a tenant-specific Gateway if the tenant has
// configured API keys; otherwise falls back to the shared global gateway.
// Results are cached for 5 minutes; UpdateSettings invalidates immediately.
func (h *AgentHandler) resolveTenantGateway(ctx context.Context, tenantID string) *llmgateway.Gateway {
 if gw, ok := h.gatewayCache.Get(tenantID); ok {
  return gw
 }

 var settingsJSON []byte
 if h.db != nil {
  _ = h.db.QueryRow(ctx,
   "SELECT settings FROM public.tenants WHERE id=$1 AND deleted_at IS NULL", tenantID,
  ).Scan(&settingsJSON)
 }

 var settings map[string]interface{}
 if len(settingsJSON) > 0 {
  _ = json.Unmarshal(settingsJSON, &settings)
 }

 apiKeys, _ := settings["llm_api_keys"].(map[string]interface{})
 qwenEnc, _ := apiKeys["qwen"].(string)
 zhipuEnc, _ := apiKeys["zhipu"].(string)

 if qwenEnc == "" && zhipuEnc == "" {
  h.gatewayCache.Set(tenantID, h.gateway, 5*time.Minute)
  return h.gateway
 }

 gw := llmgateway.NewGateway()
 gw.SetDefault(llmgateway.ProviderQwen)

 if qwenEnc != "" {
  if plain, err := crypto.Decrypt(h.aesKey, qwenEnc); err == nil {
   client := llmgateway.NewQwenClient(plain, h.logger)
   gw.RegisterClient(llmgateway.ProviderQwen, client)
   gw.RegisterEmbeddingClient(llmgateway.ProviderQwen, client)
  } else {
   h.logger.Warn("decrypt qwen key failed, falling back to global", zap.Error(err))
  }
 }
 if zhipuEnc != "" {
  if plain, err := crypto.Decrypt(h.aesKey, zhipuEnc); err == nil {
   client := llmgateway.NewZhipuClient(plain, h.logger)
   gw.RegisterClient(llmgateway.ProviderZhipu, client)
   gw.RegisterEmbeddingClient(llmgateway.ProviderZhipu, client)
  } else {
   h.logger.Warn("decrypt zhipu key failed, falling back to global", zap.Error(err))
  }
 }

 // If both decryptions failed, fall back to global gateway
 if len(gw.ListChatModels()) == 0 {
  h.gatewayCache.Set(tenantID, h.gateway, 5*time.Minute)
  return h.gateway
 }

 h.gatewayCache.Set(tenantID, gw, 5*time.Minute)
 return gw
}
```

在 `agent_handler.go` 顶部 import 块中补充（如不存在）：

```go
"encoding/json"
"github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
"github.com/byteBuilderX/ClawHermes-AI-Go/pkg/crypto"
```

- [ ] **Step 3: 修改 ExecuteAgent — 注入租户 Gateway 给 agent**

在 `ExecuteAgent` 中，`a, ok := h.agentRegistry.Get(...)` 成功后、`a.Execute(...)` 之前，插入：

```go
// Resolve tenant-specific gateway (5-min cached)
tenantGW := h.resolveTenantGateway(ctx, tenantID)
capGW := capgateway.NewDefaultCapabilityGateway(
    capgateway.NewLLMAdapter(tenantGW, h.logger),
    nil,
    h.logger,
)
// SetCapGateway is not on the Agent interface; use a local interface
// to avoid importing *BaseAgent and to silently skip other implementations.
type capGWSetter interface {
    SetCapGateway(capgateway.CapabilityGateway)
}
if setter, ok := a.(capGWSetter); ok {
    setter.SetCapGateway(capGW)
}
```

在 `agent_handler.go` 顶部 import 块中补充（如不存在）：

```go
"github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
```

- [ ] **Step 4: 编译验证**

```bash
go build ./...
```

预期：零错误。若有 import cycle 或类型不匹配，按错误信息修正。

- [ ] **Step 5: Commit**

```bash
git add api/handler/agent_handler.go
git commit -m "feat(agent): resolve tenant-specific Gateway in ExecuteAgent with 5-min cache"
```

---

## Task 5: router.go — 注入 aesKey + cache

**Files:**

- Modify: `api/router.go`

- [ ] **Step 1: 在 router.go 中派生 aesKey 并构造 cache**

在 `api/router.go` 顶部 import 中新增：

```go
"github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
"github.com/byteBuilderX/ClawHermes-AI-Go/pkg/crypto"
```

在 `SetupRouter` 函数内，`metrics := observability.NewPrometheusMetrics(logger)` 之后立即添加：

```go
aesKey := crypto.DeriveAESKey(cfg.JWTPrivateKeyPEM)
gatewayCache := llmgateway.NewTenantGatewayCache()
```

- [ ] **Step 2: 更新 NewTenantHandler 调用**

将：

```go
tenantHandler := handler.NewTenantHandler(db, logger, cfg.FrontendURL)
```

替换为：

```go
tenantHandler := handler.NewTenantHandler(db, logger, cfg.FrontendURL, aesKey, gatewayCache)
```

- [ ] **Step 3: 更新 NewAgentHandler 调用**

将：

```go
agentHandler := handler.NewAgentHandler(agentRegistry, logger, gateway, metrics, execStore)
```

替换为：

```go
agentHandler := handler.NewAgentHandler(agentRegistry, logger, gateway, metrics, execStore, db, aesKey, gatewayCache)
```

- [ ] **Step 4: 编译 + 运行现有测试**

```bash
go build ./...
go test -short ./... 2>&1 | tail -20
```

预期：build 零错误，既有测试不回退。

- [ ] **Step 5: Commit**

```bash
git add api/router.go
git commit -m "feat(router): inject aesKey and TenantGatewayCache into TenantHandler and AgentHandler"
```

---

## Task 6: 前端 SettingsPage — API Key 配置 Card

**Files:**

- Modify: `web/src/pages/tenant/SettingsPage.jsx`

**背景：** 当前页面只有"租户名称"+"头像 URL"两个字段。需在其下方新增 LLM API Key Card，使用独立 state 管理，每个 provider 独立保存，`member` 角色 disabled。

- [ ] **Step 1: 替换 SettingsPage.jsx 完整内容**

```jsx
import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Typography, message, Card, Space } from 'antd';
import { updateTenant, getTenantSettings } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const { Title } = Typography;

const SettingsPage = () => {
  const { user, login, accessToken } = useAuth();
  const [loading, setLoading] = useState(false);
  const [keyLoading, setKeyLoading] = useState({ qwen: false, zhipu: false });
  const [apiKeys, setApiKeys] = useState({ qwen: '', zhipu: '' });

  const role = user?.current_tenant?.role || 'member';
  const canEdit = role === 'owner' || role === 'admin';

  useEffect(() => {
    getTenantSettings().then((res) => {
      const keys = res.data?.settings?.llm_api_keys || {};
      setApiKeys({ qwen: keys.qwen || '', zhipu: keys.zhipu || '' });
    }).catch(() => {});
  }, []);

  const handleSave = async (values) => {
    setLoading(true);
    try {
      await updateTenant(values);
      message.success('设置已保存');
      login({ ...user, current_tenant: { ...user.current_tenant, ...values } }, accessToken);
    } catch (err) {
      message.error(err.response?.data?.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveKey = async (provider) => {
    setKeyLoading((prev) => ({ ...prev, [provider]: true }));
    try {
      await updateTenant({ settings: { llm_api_keys: { [provider]: apiKeys[provider] } } });
      message.success('API Key 已保存');
    } catch (err) {
      message.error(err.response?.data?.message || '保存失败');
    } finally {
      setKeyLoading((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const providerLabels = { qwen: 'Qwen API Key', zhipu: 'Zhipu API Key' };

  return (
    <div>
      <Title level={4} style={{ marginBottom: 24 }}>租户设置</Title>
      <Card style={{ maxWidth: 480, marginBottom: 24 }}>
        <Form
          layout="vertical"
          initialValues={{
            name: user?.current_tenant?.name || '',
            avatar_url: user?.current_tenant?.avatar_url || '',
          }}
          onFinish={handleSave}
        >
          <Form.Item label="租户名称" name="name" rules={[{ required: true, message: '请输入租户名称' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="头像 URL" name="avatar_url">
            <Input placeholder="https://example.com/avatar.png" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>保存</Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="LLM API Key 配置" style={{ maxWidth: 480 }}>
        {Object.entries(providerLabels).map(([provider, label]) => (
          <Form.Item key={provider} label={label} style={{ marginBottom: 16 }}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={apiKeys[provider]}
                placeholder="未配置"
                disabled={!canEdit}
                onChange={(e) => setApiKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
              />
              {canEdit && (
                <Button
                  type="primary"
                  loading={keyLoading[provider]}
                  onClick={() => handleSaveKey(provider)}
                >
                  保存
                </Button>
              )}
            </Space.Compact>
          </Form.Item>
        ))}
        {!canEdit && (
          <p style={{ color: '#8c8c8c', fontSize: 12, margin: 0 }}>仅 owner/admin 可修改 API Key</p>
        )}
      </Card>
    </div>
  );
};

export default SettingsPage;
```

- [ ] **Step 2: 新增 getTenantSettings API 函数**

在 `web/src/services/api.js` 中找到 `updateTenant` 所在行，在其上方新增：

```js
export const getTenantSettings = () => api.get('/tenant/settings');
```

- [ ] **Step 3: 验证前端编译**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go/web
npm run build 2>&1 | tail -20
```

预期：build 成功，无错误。

- [ ] **Step 4: Commit**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
git add web/src/pages/tenant/SettingsPage.jsx web/src/services/api.js
git commit -m "feat(frontend): add per-provider LLM API Key config card in SettingsPage"
```

---

## Task 7: 全量测试 + 完整验证

- [ ] **Step 1: 运行全量 Go 测试**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go test -race -timeout 60s ./...
```

预期：所有测试 PASS，无 data race

- [ ] **Step 2: 运行前端 lint**

```bash
cd web && npm run lint 2>&1 | tail -20
```

预期：无 error

- [ ] **Step 3: 最终 commit（如有遗漏文件）**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
git status
# 确认 working tree clean
```
