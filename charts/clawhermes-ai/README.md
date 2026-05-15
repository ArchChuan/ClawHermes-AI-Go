# ClawHermes AI Go Helm Chart

这是一个用于部署 ClawHermes AI Go 应用的 Helm Chart。

## 介绍

ClawHermes AI Go 是一个面向企业私有化部署的 AI 应用编排平台，融合 OpenClaw Skill 原子化架构、Hermes 事件驱动异步通信、Harness AI 可观测与灰度发布、MCP 统一工具/模型协议、GraphRAG 知识增强。

## 功能特性

- 🧠 **多 Agent 协作** - ReAct、CoT、Planning、Tool Calling、RAG、Swarm 模式
- 📚 **知识增强** - GraphRAG 知识图谱增强检索
- 🔄 **事件驱动** - NATS 异步事件总线
- 📊 **可观测性** - OpenTelemetry 全链路追踪
- 📈 **云原生** - Kubernetes + Helm + Prometheus + Jaeger

## 前置要求

- Kubernetes 1.19+
- Helm 3.0+
- PV provisioner 支持（可选，用于持久化）

## 安装

### 添加 Helm 仓库

```bash
helm repo add clawhermes https://charts.clawhermes.ai
helm repo update
```

### 安装 Chart

```bash
# 基本安装
helm install clawhermes clawhermes/clawhermes-ai

# 自定义配置安装
helm install clawhermes clawhermes/clawhermes-ai -f values.yaml

# 指定命名空间安装
helm install clawhermes clawhermes/clawhermes-ai --namespace clawhermes --create-namespace
```

### 使用本地 Chart

```bash
# 从本地 Chart 安装
helm install clawhermes ./charts/clawhermes-ai

# 打包并安装
helm package ./charts/clawhermes-ai
helm install clawhermes clawhermes-ai-1.0.0.tgz
```

## 配置

| 参数 | 描述 | 默认值 |
|------|------|--------|
| `replicaCount` | 副本数量 | `3` |
| `image.repository` | 镜像仓库 | `clawhermes-ai` |
| `image.tag` | 镜像标签 | `latest` |
| `app.port` | 应用端口 | `8080` |
| `app.logLevel` | 日志级别 | `info` |
| `otel.enabled` | 启用 OpenTelemetry | `true` |
| `otel.exporterType` | Trace 导出器类型 | `otlp` |
| `prometheus.enabled` | 启用 Prometheus | `true` |
| `resources.requests.cpu` | CPU 请求 | `100m` |
| `resources.requests.memory` | 内存请求 | `256Mi` |
| `autoscaling.enabled` | 启用自动伸缩 | `true` |
| `ingress.enabled` | 启用 Ingress | `true` |

完整参数请参考 `values.yaml`。

## 升级

```bash
# 升级 Chart
helm upgrade clawhermes clawhermes/clawhermes-ai

# 升级并指定配置文件
helm upgrade clawhermes clawhermes/clawhermes-ai -f values.yaml
```

## 回滚

```bash
# 查看历史版本
helm history clawhermes

# 回滚到上一个版本
helm rollback clawhermes

# 回滚到指定版本
helm rollback clawhermes 2
```

## 卸载

```bash
# 卸载
helm uninstall clawhermes

# 卸载并保留历史
helm uninstall clawhermes --keep-history
```

## 监控

### Prometheus

ServiceMonitor 会自动创建，Prometheus Operator 会自动发现和抓取指标。

指标端点: `http://service-name:8080/metrics`

### Jaeger

Trace 数据通过 OTLP 协议发送到 Jaeger，可以通过 Jaeger UI 查询和可视化追踪。

访问 Jaeger: `http://jaeger:16686`

## 故障排除

### Pod 无法启动

```bash
# 查看 Pod 状态
kubectl get pods -n clawhermes

# 查看 Pod 日志
kubectl logs -n clawhermes -l app=clawhermes-ai

# 查看 Pod 描述
kubectl describe pod -n clawhermes -l app=clawhermes-ai
```

### 服务无法访问

```bash
# 查看 Service 状态
kubectl get svc -n clawhermes

# 查看 Service 端点
kubectl get endpoints -n clawhermes clawhermes-ai

# 测试服务连通性
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- sh
curl http://clawhermes-ai:80/health
```

### 指标未被抓取

```bash
# 查看 ServiceMonitor
kubectl get servicemonitor -n clawhermes

# 查看 Prometheus target
kubectl port-forward -n monitoring svc/prometheus-operator-prometheus 9090:9090
# 访问 http://localhost:9090/targets
```

## 开发

### 本地测试

```bash
# 模板渲染（不安装）
helm template clawhermes ./charts/clawhermes-ai

# 渲染到文件
helm template clawhermes ./charts/clawhermes-ai > rendered.yaml

# 验证模板
helm lint ./charts/clawhermes-ai

# dry-run 安装
helm install clawhermes ./charts/clawhermes-ai --dry-run --debug
```

### 构建 Chart

```bash
# 打包 Chart
helm package ./charts/clawhermes-ai

# 索引 Chart
helm repo index .

# 上传到 Helm 仓库
helm push clawhermes-ai-1.0.0.tgz https://charts.clawhermes.ai
```

## 更多信息

- [ClawHermes AI Go 文档](https://github.com/byteBuilderX/ClawHermes-AI-Go)
- [Kubernetes 文档](https://kubernetes.io/docs/)
- [Helm 文档](https://helm.sh/docs/)
- [OpenTelemetry 文档](https://opentelemetry.io/docs/)
- [Prometheus 文档](https://prometheus.io/docs/)

## 许可证

Apache License 2.0