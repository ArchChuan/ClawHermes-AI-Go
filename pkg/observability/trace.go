package observability

import (
	"context"

	"go.uber.org/zap"
)

// 简化版的 Trace 包，暂时不包含 OpenTelemetry 依赖

// TraceConfig 定义 trace 配置
type TraceConfig struct {
	ServiceName    string
	ServiceVersion string
	Environment    string // production, development, staging
	ExporterType   string // jaeger, otlp, stdout, none
	SamplingRatio  float64
	JaegerEndpoint string
	OTLPEndpoint   string
}

// DefaultTraceConfig 返回默认配置
func DefaultTraceConfig() *TraceConfig {
	return &TraceConfig{
		ServiceName:    "clawhermes-ai",
		ServiceVersion: "1.0.0",
		Environment:    "development",
		ExporterType:   "none", // 默认禁用，避免依赖问题
		SamplingRatio:  1.0,
		JaegerEndpoint: "http://localhost:14268/api/traces",
		OTLPEndpoint:   "localhost:4317",
	}
}

// InitTracer 初始化跟踪器（当前为空实现以避免依赖问题）
func InitTracer(cfg *TraceConfig, logger *zap.Logger) (interface{}, error) {
	logger.Info("tracing disabled to avoid dependency issues")
	return nil, nil
}

// Tracer 封装跟踪功能
type Tracer struct {
	logger *zap.Logger
}

// NewTracer 创建新的 Tracer
func NewTracer(logger *zap.Logger) *Tracer {
	return &Tracer{
		logger: logger,
	}
}

// StartSpan 创建一个新的 span
func (t *Tracer) StartSpan(ctx context.Context, name string) (context.Context, interface{}) {
	return ctx, nil
}