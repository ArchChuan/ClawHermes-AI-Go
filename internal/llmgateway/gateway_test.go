package llmgateway

import (
	"testing"
)

func TestNewGateway(t *testing.T) {
	gateway := NewGateway()

	if gateway == nil {
		t.Error("expected Gateway to be non-nil")
	}
}

func TestListChatModels_empty(t *testing.T) {
	g := NewGateway()
	models := g.ListChatModels()
	if len(models) != 0 {
		t.Errorf("expected empty, got %v", models)
	}
}

func TestListChatModels_sorted(t *testing.T) {
	g := NewGateway()
	g.RegisterClient(ProviderZhipu, &ZhipuClient{})
	g.RegisterClient(ProviderQwen, &QwenClient{})

	models := g.ListChatModels()
	if len(models) == 0 {
		t.Fatal("expected models, got none")
	}
	for i := 1; i < len(models); i++ {
		if models[i] < models[i-1] {
			t.Errorf("not sorted: %v", models)
			break
		}
	}
	// both providers represented
	hasQwen, hasGlm := false, false
	for _, m := range models {
		if m == "qwen-turbo" {
			hasQwen = true
		}
		if m == "glm-4-flash" {
			hasGlm = true
		}
	}
	if !hasQwen || !hasGlm {
		t.Errorf("expected qwen-turbo and glm-4-flash in %v", models)
	}
}
