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
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type ExecuteSkillRequest struct {
	Input interface{} `json:"input"`
}

type ExecuteSkillResponse struct {
	Result interface{} `json:"result"`
	Error  string      `json:"error,omitempty"`
}
