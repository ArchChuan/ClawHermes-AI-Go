#!/bin/bash
set -euo pipefail

echo "🚀 初始化 ClawHermes AI K8s 部署环境..."

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 函数：打印步骤
print_step() {
  echo -e "${BLUE}>>> $1${NC}"
}

# 函数：打印成功
print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

# 函数：打印提示
print_info() {
  echo -e "${YELLOW}ℹ $1${NC}"
}

# 参数检查
ENVIRONMENT="${1:-dev}"
NAMESPACE="clawhermes"

if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
  echo "Usage: $0 [dev|staging|prod]"
  exit 1
fi

print_step "检查 kubectl 连接..."
if ! kubectl cluster-info &>/dev/null; then
  echo "❌ 无法连接到 K8s 集群"
  exit 1
fi
print_success "K8s 集群连接正常"

print_step "创建 namespace: $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
print_success "Namespace 创建完成"

print_step "应用基础配置..."

# 应用 RBAC 配置
kubectl apply -f k8s/namespace.yaml
print_success "Namespace 配置应用完成"

# 应用安全策略
kubectl apply -f k8s/security.yaml
print_success "安全策略应用完成"

# 应用网络策略
kubectl apply -f k8s/network-policy.yaml
print_success "网络策略应用完成"

print_step "配置应用 ConfigMap..."

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: clawhermes-config
  namespace: $NAMESPACE
data:
  PORT: "8080"
  LOG_LEVEL: "$([ "$ENVIRONMENT" = "prod" ] && echo "warn" || echo "info")"
  ENVIRONMENT: "$ENVIRONMENT"
  NATS_URL: "nats://nats:4222"
  MILVUS_HOST: "milvus"
  MILVUS_PORT: "19530"
  NEO4J_URI: "bolt://neo4j:7687"
  NEO4J_USER: "neo4j"
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317"
  OTEL_SERVICE_NAME: "clawhermes-ai-$ENVIRONMENT"
  OTEL_EXPORTER_TYPE: "otlp"
  OTEL_SAMPLING_RATIO: "$([ "$ENVIRONMENT" = "prod" ] && echo "0.1" || echo "0.5")"
EOF

print_success "ConfigMap 配置完成"

print_step "应用依赖服务..."
kubectl apply -f k8s/dependencies.yaml
print_success "依赖服务配置完成"

print_step "应用监控配置..."
kubectl apply -f k8s/monitoring.yaml
print_success "监控配置完成"

print_info "部署脚本文件已同步权限"
chmod +x scripts/deploy/*.sh

echo ""
echo "✅ K8s 环境初始化完成！"
echo ""
echo "📋 下一步："
echo "1. 配置 Secret (生产环境必需):"
echo "   kubectl create secret generic clawhermes-secrets \\"
echo "     --from-literal=NEO4J_PASSWORD=<password> \\"
echo "     --from-literal=OPENAI_API_KEY=<api-key> \\"
echo "     --from-literal=JWT_SECRET=<secret> \\"
echo "     -n $NAMESPACE"
echo ""
echo "2. 部署应用:"
echo "   kubectl apply -f k8s/deployment.yaml"
echo "   或使用 Helm:"
echo "   helm install clawhermes ./charts/clawhermes-ai -n $NAMESPACE -f values-$ENVIRONMENT.yaml"
echo ""
echo "3. 验证部署:"
echo "   kubectl get pods -n $NAMESPACE"
echo "   kubectl logs -n $NAMESPACE -l app=clawhermes-ai --tail=100 -f"
