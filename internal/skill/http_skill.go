package skill

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"text/template"
	"time"
)

type HTTPSkill struct {
	*BaseSkill
	URL          string
	Method       string
	Headers      map[string]string
	BodyTemplate string
	TimeoutSec   int
}

func NewHTTPSkill(id, name, description, url, method string, headers map[string]string, bodyTemplate string, timeoutSec int) *HTTPSkill {
	if method == "" {
		method = "POST"
	}
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	return &HTTPSkill{
		BaseSkill: &BaseSkill{
			ID:          id,
			Name:        name,
			Description: description,
			Type:        "http",
		},
		URL:          url,
		Method:       method,
		Headers:      headers,
		BodyTemplate: bodyTemplate,
		TimeoutSec:   timeoutSec,
	}
}

func (hs *HTTPSkill) GetConfig() map[string]any {
	return map[string]any{
		"url":           hs.URL,
		"method":        hs.Method,
		"headers":       hs.Headers,
		"body_template": hs.BodyTemplate,
		"timeout_sec":   hs.TimeoutSec,
	}
}

func (hs *HTTPSkill) Execute(ctx context.Context, input interface{}) (interface{}, error) {
	inputMap, _ := input.(map[string]interface{})

	// render body template
	var bodyReader io.Reader
	if hs.BodyTemplate != "" {
		tmpl, err := template.New("body").Parse(hs.BodyTemplate)
		if err != nil {
			return nil, fmt.Errorf("invalid body template: %w", err)
		}
		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, inputMap); err != nil {
			return nil, fmt.Errorf("body template render failed: %w", err)
		}
		bodyReader = &buf
	} else if inputMap != nil {
		b, err := json.Marshal(inputMap)
		if err != nil {
			return nil, fmt.Errorf("marshal input: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	client := &http.Client{Timeout: time.Duration(hs.TimeoutSec) * time.Second}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(hs.Method), hs.URL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	if bodyReader != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hs.Headers {
		req.Header.Set(k, v)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	result := map[string]interface{}{
		"status_code": resp.StatusCode,
	}

	var parsed interface{}
	if json.Unmarshal(rawBody, &parsed) == nil {
		result["body"] = parsed
	} else {
		result["body"] = string(rawBody)
	}

	if resp.StatusCode >= 400 {
		return result, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(rawBody))
	}
	return result, nil
}
