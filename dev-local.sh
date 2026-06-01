#!/bin/bash
# 方案一：本地前端 dev server + minikube 后端 port-forward
# 前端热重载，后端跑在 minikube 里，通过 port-forward 暴露到 localhost:8080

set -e

BACKEND_SVC="clawhermes-ai"
BACKEND_NS="clawhermes"
BACKEND_LOCAL_PORT=8080
BACKEND_SVC_PORT=80

cleanup() {
    echo ""
    echo "🛑 停止 port-forward..."
    kill "$PF_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# 检查 minikube
if ! minikube status &>/dev/null; then
    echo "❌ minikube 未运行，请先执行: minikube start"
    exit 1
fi

# 检查后端 pod 是否就绪
echo "🔍 检查后端 pod 状态..."
if ! kubectl get deployment "$BACKEND_SVC" -n "$BACKEND_NS" &>/dev/null; then
    echo "❌ 后端 deployment '$BACKEND_SVC' 不存在，请先部署后端"
    exit 1
fi

READY=$(kubectl get deployment "$BACKEND_SVC" -n "$BACKEND_NS" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "${READY:-0}" -lt 1 ]; then
    echo "⚠️  后端 pod 尚未就绪，等待..."
    kubectl wait --for=condition=available deployment/"$BACKEND_SVC" \
        -n "$BACKEND_NS" --timeout=60s
fi

# 启动 port-forward（后台）
echo "🔗 转发后端: localhost:$BACKEND_LOCAL_PORT → $BACKEND_SVC:$BACKEND_SVC_PORT"
kubectl port-forward svc/"$BACKEND_SVC" \
    "$BACKEND_LOCAL_PORT:$BACKEND_SVC_PORT" \
    -n "$BACKEND_NS" &>/tmp/pf-backend.log &
PF_PID=$!

# 等待 port-forward 就绪
sleep 2
if ! kill -0 "$PF_PID" 2>/dev/null; then
    echo "❌ port-forward 启动失败，查看日志: cat /tmp/pf-backend.log"
    exit 1
fi
echo "✓ 后端已转发到 http://localhost:$BACKEND_LOCAL_PORT"

# 检查前端依赖
if [ ! -d "web/node_modules" ]; then
    echo "📦 安装前端依赖..."
    cd web && npm install && cd ..
fi

echo ""
echo "🚀 启动前端开发服务器..."
echo "   前端: http://localhost:3002"
echo "   后端: http://localhost:$BACKEND_LOCAL_PORT (via port-forward)"
echo "   按 Ctrl+C 停止"
echo ""

cd web && npm run dev -- --mode minikube
