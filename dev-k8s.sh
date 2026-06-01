#!/bin/bash
# 方案二：全 minikube 部署（前端也进集群，Ingress 统一入口）
# 访问地址: http://clawhermes.local
# 需要在 /etc/hosts 加一行: <minikube-ip> clawhermes.local

set -e

MINIKUBE_IP=$(minikube ip 2>/dev/null)
HOSTS_ENTRY="$MINIKUBE_IP clawhermes.local"

# 检查 minikube
if ! minikube status &>/dev/null; then
    echo "❌ minikube 未运行，请先执行: minikube start"
    exit 1
fi

# 检查 ingress-nginx addon
if ! minikube addons list | grep -q "ingress.*enabled"; then
    echo "🔧 启用 ingress-nginx addon..."
    minikube addons enable ingress
    echo "⏳ 等待 ingress-nginx 就绪..."
    kubectl wait --namespace ingress-nginx \
        --for=condition=ready pod \
        --selector=app.kubernetes.io/component=controller \
        --timeout=120s
fi

# 构建前端镜像（在 minikube docker 环境内）
echo "🐳 在 minikube 环境内构建前端镜像..."
eval "$(minikube docker-env)"
docker build -t clawhermes-frontend:local --build-arg BUILD_MODE=development -f web/Dockerfile web/
echo "✓ 前端镜像构建完成: clawhermes-frontend:local"

# 部署前端 k8s 资源
echo "📦 部署前端到 minikube..."
kubectl apply -f k8s/frontend-configmap.yaml
kubectl apply -f k8s/frontend-deployment.yaml
kubectl apply -f k8s/frontend-service.yaml

# 部署 ingress
echo "🌐 部署本地 Ingress..."
kubectl apply -f k8s/ingress-local.yaml

# 等待前端 pod 就绪
echo "⏳ 等待前端 pod 就绪..."
kubectl wait --for=condition=available deployment/frontend \
    -n clawhermes --timeout=120s

# 检查 /etc/hosts
echo ""
if grep -q "clawhermes.local" /etc/hosts 2>/dev/null; then
    CURRENT_IP=$(grep "clawhermes.local" /etc/hosts | awk '{print $1}')
    if [ "$CURRENT_IP" != "$MINIKUBE_IP" ]; then
        echo "⚠️  /etc/hosts 中 clawhermes.local 的 IP 已过期 ($CURRENT_IP)，需要更新"
        echo "   请执行: sudo sed -i 's|.*clawhermes.local|$HOSTS_ENTRY|' /etc/hosts"
    else
        echo "✓ /etc/hosts 已配置: $HOSTS_ENTRY"
    fi
else
    echo "📝 请将以下内容添加到 /etc/hosts（需要 sudo）:"
    echo ""
    echo "   $HOSTS_ENTRY"
    echo ""
    echo "   快速执行: echo '$HOSTS_ENTRY' | sudo tee -a /etc/hosts"
fi

echo ""
echo "✅ 部署完成！"
echo "   访问地址: http://clawhermes.local"
echo "   后端 API:  http://clawhermes.local/api/"
echo ""
echo "🔧 常用命令:"
echo "   查看前端日志: kubectl logs -f deployment/frontend -n clawhermes"
echo "   重新部署前端: $0"
echo "   清理 ingress:  kubectl delete -f k8s/ingress-local.yaml"
