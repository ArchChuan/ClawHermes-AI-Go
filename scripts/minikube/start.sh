#!/bin/bash
set -euo pipefail

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_step() {
  echo -e "${BLUE}>>> $1${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

# 检查依赖
print_step "检查依赖..."

if ! command -v minikube &> /dev/null; then
  print_error "minikube 未安装"
  echo "安装: https://minikube.sigs.k8s.io/docs/start/"
  exit 1
fi
print_success "minikube 已安装"

if ! command -v kubectl &> /dev/null; then
  print_error "kubectl 未安装"
  exit 1
fi
print_success "kubectl 已安装"

if ! command -v docker &> /dev/null; then
  print_error "docker 未安装"
  exit 1
fi
print_success "docker 已安装"

# 启动 Minikube
print_step "启动 Minikube..."

# 检查 Minikube 是否已运行
if minikube status &>/dev/null; then
  STATUS=$(minikube status --format='{{.Host}}')
  if [ "$STATUS" = "Running" ]; then
    print_success "Minikube 已在运行"
  else
    print_step "重新启动 Minikube..."
    minikube start \
      --cpus=4 \
      --memory=8192 \
      --disk-size=50g \
      --driver=docker \
      --cni=flannel \
      --enable-metrics-server \
      --addons=metrics-server
    print_success "Minikube 已启动"
  fi
else
  print_step "首次启动 Minikube..."
  minikube start \
    --cpus=4 \
    --memory=8192 \
    --disk-size=50g \
    --driver=docker \
    --cni=flannel \
    --addons=metrics-server
  print_success "Minikube 已启动"
fi

# 等待集群就绪
print_step "等待集群就绪..."
kubectl wait --for=condition=ready node minikube --timeout=300s || true

# 启用 Ingress addon
print_step "启用 Ingress addon..."
minikube addons enable ingress || true
print_success "Ingress 已启用"

# 启用 Dashboard addon
print_step "启用 Dashboard addon..."
minikube addons enable dashboard || true
print_success "Dashboard 已启用"

# 创建 namespace
print_step "创建 clawhermes namespace..."
kubectl create namespace clawhermes --dry-run=client -o yaml | kubectl apply -f -
print_success "Namespace 已创建"

# 设置镜像加速（可选，如果需要）
print_step "配置镜像源..."
minikube ssh -- docker run -d --restart=always -p 5000:5000 registry:2 || true
print_success "镜像仓库已配置"

# 显示访问信息
print_step "获取访问信息..."
echo ""
MINIKUBE_IP=$(minikube ip)
echo -e "${YELLOW}Minikube IP: ${MINIKUBE_IP}${NC}"
echo ""
echo "📋 有用的命令:"
echo "  kubectl cluster-info              - 查看集群信息"
echo "  minikube dashboard                - 打开 Dashboard"
echo "  minikube docker-env               - 查看 Docker 环境"
echo "  eval \$(minikube docker-env)      - 配置 Docker 环境"
echo ""
echo "🔌 端口转发示例:"
echo "  kubectl port-forward -n clawhermes svc/clawhermes-ai 8080:80"
echo ""

print_success "Minikube 启动完成！"
