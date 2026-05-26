#!/bin/bash
set -euo pipefail

NAMESPACE="${1:-clawhermes}"

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_step() {
  echo -e "${BLUE}>>> $1${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_step "部署应用到本地 Minikube..."

# 检查 kubectl 连接
print_step "检查 kubectl 连接..."
if ! kubectl cluster-info &>/dev/null; then
  echo "❌ 无法连接到 Minikube"
  exit 1
fi
print_success "kubectl 连接正常"

# 检查镜像
print_step "检查 Docker 镜像..."
eval "$(minikube docker-env)"
if ! docker images | grep -q "clawhermes-ai-go.*local"; then
  print_step "镜像不存在，开始构建..."
  docker build -t clawhermes-ai-go:local -f Dockerfile .
  print_success "镜像已构建"
else
  print_success "镜像已存在"
fi

# 检查 namespace
print_step "检查 namespace..."
kubectl get namespace "$NAMESPACE" &>/dev/null || kubectl create namespace "$NAMESPACE"
print_success "Namespace 已就绪"

# 检查 ConfigMap
print_step "应用配置..."
kubectl create configmap clawhermes-config \
  --from-literal=PORT=8080 \
  --from-literal=LOG_LEVEL=info \
  --from-literal=ENVIRONMENT=dev \
  --from-literal=NATS_URL=nats://nats:4222 \
  --from-literal=MILVUS_HOST=milvus \
  --from-literal=MILVUS_PORT=19530 \
  --from-literal=NEO4J_URI=bolt://neo4j:7687 \
  --from-literal=NEO4J_USER=neo4j \
  --from-literal=OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \
  --from-literal=OTEL_SERVICE_NAME=clawhermes-ai-dev \
  --from-literal=OTEL_EXPORTER_TYPE=otlp \
  --from-literal=OTEL_SAMPLING_RATIO=1.0 \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
print_success "配置已应用"

# 应用 k8s manifests
print_step "应用 Kubernetes 配置..."

# 更新镜像为本地镜像
print_step "更新镜像配置..."
sed 's|image:.*clawhermes-ai:latest|image: clawhermes-ai-go:local|g; s|imagePullPolicy:.*IfNotPresent|imagePullPolicy: Never|g' k8s/deployment.yaml | \
  kubectl apply -f - -n "$NAMESPACE"

print_success "应用已部署"

# 等待部署
print_step "等待部署就绪..."
kubectl rollout status deployment/clawhermes-ai -n "$NAMESPACE" --timeout=2m || {
  echo "❌ 部署超时，查看 Pod 状态:"
  kubectl get pods -n "$NAMESPACE" -l app=clawhermes-ai
  exit 1
}
print_success "部署已就绪"

# 显示访问信息
echo ""
echo "✅ 部署完成！"
echo ""
echo "📋 访问信息:"
MINIKUBE_IP=$(minikube ip)
echo "  应用地址: http://$MINIKUBE_IP:80"
echo "  或使用端口转发: kubectl port-forward -n $NAMESPACE svc/clawhermes-ai 8080:80"
echo ""
echo "📊 查看日志:"
echo "  kubectl logs -n $NAMESPACE -l app=clawhermes-ai -f"
echo ""
echo "🔍 查看状态:"
echo "  kubectl get pods -n $NAMESPACE -w"
