#!/bin/bash
set -euo pipefail

NAMESPACE="${1:-clawhermes}"
ENVIRONMENT="${2:-dev}"

echo "Verifying deployment in $ENVIRONMENT environment..."

# 检查部署是否存在
if ! kubectl get deployment clawhermes-ai -n "$NAMESPACE" &>/dev/null; then
  echo "❌ Deployment clawhermes-ai not found in namespace $NAMESPACE"
  exit 1
fi

# 检查 Pod 是否就绪
echo "⏳ Checking pod readiness..."
READY_REPLICAS=$(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')
DESIRED_REPLICAS=$(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')

if [[ "$READY_REPLICAS" != "$DESIRED_REPLICAS" ]]; then
  echo "❌ Pod readiness check failed: $READY_REPLICAS/$DESIRED_REPLICAS replicas ready"
  exit 1
fi

echo "✅ All replicas ready: $READY_REPLICAS/$DESIRED_REPLICAS"

# 获取服务 IP
SERVICE_IP=$(kubectl get service clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
if [[ -z "$SERVICE_IP" ]]; then
  SERVICE_IP=$(kubectl get service clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}')
fi

echo "Service IP: $SERVICE_IP"

# 健康检查（通过 kubectl 端口转发）
echo "⏳ Running health check..."
POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l app=clawhermes-ai -o jsonpath='{.items[0].metadata.name}')

if ! kubectl exec -n "$NAMESPACE" "$POD_NAME" -- curl -sf http://localhost:8080/health > /dev/null; then
  echo "❌ Health check failed"
  kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=50
  exit 1
fi

echo "✅ Health check passed"

# 检查指标端点
echo "⏳ Checking metrics endpoint..."
if ! kubectl exec -n "$NAMESPACE" "$POD_NAME" -- curl -sf http://localhost:8080/metrics > /dev/null; then
  echo "⚠️  Metrics endpoint not responding (non-critical)"
else
  echo "✅ Metrics endpoint healthy"
fi

# 检查最近的事件
echo ""
echo "Recent pod events:"
kubectl describe pods -n "$NAMESPACE" -l app=clawhermes-ai | grep -A 20 "Events:" || true

echo ""
echo "✅ Deployment verification successful!"
