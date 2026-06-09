# Dynamic Model List Design

## Goal

Replace hardcoded, unavailable model names in `CreateAgentPage.jsx` with a dynamic list fetched from the backend, showing only configured chat models (no embedding models).

## Architecture

A new `GET /models` endpoint calls `gateway.ListChatModels()`, which aggregates models from all registered `LLMClient` implementations. Each client declares its own supported model names via a new `Models() []string` interface method. The frontend fetches this list on mount and populates the Select.

## Tech Stack

Go 1.21 · gin · `internal/llmgateway` · React 18 · Ant Design 5 · axios

---

## Backend

### Interface Change — `LLMClient.Models()`

Add `Models() []string` to the `LLMClient` interface in `internal/llmgateway/gateway.go`:

```go
type LLMClient interface {
    Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error)
    Health(ctx context.Context) error
    Models() []string
}
```

### Implementations

**`QwenClient.Models()`** (`internal/llmgateway/qwen.go`):

```go
func (c *QwenClient) Models() []string {
    return []string{"qwen-turbo", "qwen-plus", "qwen-max", "qwen-long"}
}
```

**`ZhipuClient.Models()`** (`internal/llmgateway/zhipu.go`):

```go
func (c *ZhipuClient) Models() []string {
    return []string{"glm-4-flash", "glm-4", "glm-4-air", "glm-4v"}
}
```

### Gateway Method — `ListChatModels()`

Add to `internal/llmgateway/gateway.go`:

```go
// ListChatModels returns all chat model names across registered providers, sorted.
func (g *Gateway) ListChatModels() []string {
    var models []string
    for _, client := range g.clients {
        models = append(models, client.Models()...)
    }
    sort.Strings(models)
    return models
}
```

### Handler — `ModelHandler`

New file `api/handler/model_handler.go`:

```go
package handler

import (
    "net/http"
    "github.com/gin-gonic/gin"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
)

type ModelHandler struct {
    gateway *llmgateway.Gateway
}

func NewModelHandler(gateway *llmgateway.Gateway) *ModelHandler {
    return &ModelHandler{gateway: gateway}
}

// ListModels GET /models
func (h *ModelHandler) ListModels(c *gin.Context) {
    models := h.gateway.ListChatModels()
    c.JSON(http.StatusOK, gin.H{"models": models})
}
```

### Router Registration

In `api/router.go`, register in the public (no-auth) section alongside `/health`:

```go
modelHandler := handler.NewModelHandler(gateway)
router.GET("/models", modelHandler.ListModels)
```

### Response Shape

```json
{ "models": ["glm-4", "glm-4-air", "glm-4-flash", "glm-4v", "qwen-long", "qwen-max", "qwen-plus", "qwen-turbo"] }
```

Empty array `[]` when no providers are configured.

---

## Frontend

### `services/api.js`

Add one function:

```js
export const getAvailableModels = () => api.get('/models');
```

### `CreateAgentPage.jsx`

Replace static `availableModels` state with dynamic loading:

```jsx
const [availableModels, setAvailableModels] = useState([]);
const [modelsLoading, setModelsLoading] = useState(true);

useEffect(() => {
    loadModels();
    loadSkills();
}, []);

const loadModels = async () => {
    try {
        const res = await getAvailableModels();
        const models = res.data.models || [];
        setAvailableModels(models);
        if (models.length > 0) {
            form.setFieldValue('llmModel', models[0]);
        }
    } catch {
        message.error('加载模型列表失败');
    } finally {
        setModelsLoading(false);
    }
};
```

Form `initialValues` changes `llmModel: 'gpt-4'` → `llmModel: ''`.

Select component:

```jsx
<Select placeholder="请选择LLM模型" loading={modelsLoading}>
    {availableModels.map(model => (
        <Option key={model} value={model}>{model}</Option>
    ))}
</Select>
```

---

## Error Handling

- Backend: no providers configured → returns `{"models": []}` with HTTP 200
- Frontend: API failure → `message.error('加载模型列表失败')`, Select stays empty (user cannot submit due to required rule)

## Testing

Backend:

- Unit test `Gateway.ListChatModels()` with zero, one, and two providers registered
- Unit test `ModelHandler.ListModels` via `httptest`

Frontend:

- Verify Select shows backend models after page load
- Verify Select shows loading spinner while fetching
- Verify empty state when API returns `[]`
