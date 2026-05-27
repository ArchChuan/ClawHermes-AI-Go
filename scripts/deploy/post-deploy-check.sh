#!/bin/bash
set -euo pipefail

NAMESPACE="${1:-clawhermes}"
ENVIRONMENT="${2:-prod}"

echo "Running post-deployment checks for $ENVIRONMENT..."

# 等待一段时间让应用稳定
sleep 5

# 检查 Pod 状态
echo "⏳ Checking pod status..."
POD_STATUS=$(kubectl get pods -n "$NAMESPACE" -l app=clawhermes-ai --no-headers 2>/dev/null | wc -l)
if [[ $POD_STATUS -eq 0 ]]; then
  echo "❌ No pods found"
  exit 1
fi
echo "✅ Found $POD_STATUS pods"

# 检查 Pod CrashLoopBackOff
CRASHED_PODS=$(kubectl get pods -n "$NAMESPACE" -l app=clawhermes-ai -o jsonpath='{.items[?(@.status.containerStatuses[0].state.waiting.reason=="CrashLoopBackOff")].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$CRASHED_PODS" ]]; then
  echo "❌ Found crashed pods: $CRASHED_PODS"
  echo "Pod logs:"
  for pod in $CRASHED_PODS; do
    echo "--- $pod ---"
    kubectl logs -n "$NAMESPACE" "$pod" --tail=20 || true
  done
  exit 1
fi
echo "✅ No crashed pods"

# 检查错误日志
echo "⏳ Checking for errors in logs..."
POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l app=clawhermes-ai -o jsonpath='{.items[0].metadata.name}')
ERROR_COUNT=$(kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=100 2>/dev/null | grep -i "error\|fatal" | wc -l || echo 0)

if [[ $ERROR_COUNT -gt 10 ]]; then
  echo "⚠️  Found $ERROR_COUNT errors in logs (checking if critical)..."
  kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=20
fi
echo "✅ Log check completed"

# 检查内存使用
echo "⏳ Checking resource usage..."
MEMORY_USAGE=$(kubectl top pod -n "$NAMESPACE" -l app=clawhermes-ai --no-headers 2>/dev/null | awk '{print $2}' | head -1 || echo "unknown")
CPU_USAGE=$(kubectl top pod -n "$NAMESPACE" -l app=clawhermes-ai --no-headers 2>/dev/null | awk '{print $3}' | head -1 || echo "unknown")
echo "Memory: $MEMORY_USAGE, CPU: $CPU_USAGE"

# 检查 HPA 状态
echo "⏳ Checking HPA status..."
if kubectl get hpa clawhermes-ai-hpa -n "$NAMESPACE" &>/dev/null; then
  HPA_STATUS=$(kubectl get hpa clawhermes-ai-hpa -n "$NAMESPACE" -o jsonpath='{.status.currentReplicas}/{.spec.maxReplicas}')
  echo "✅ HPA active: $HPA_STATUS replicas"
fi

# 检查服务端点
echo "⏳ Checking service endpoints..."
ENDPOINTS=$(kubectl get endpoints clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.subsets[0].addresses[*].ip}' 2>/dev/null | wc -w)
if [[ $ENDPOINTS -eq 0 ]]; then
  echo "❌ No service endpoints"
  exit 1
fi
echo "✅ Service has $ENDPOINTS active endpoints"

# 检查 Ingress (如果存在)
echo "⏳ Checking ingress..."
if kubectl get ingress -n "$NAMESPACE" &>/dev/null; then
  INGRESS_HOST=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || echo "")
  if [[ -n "$INGRESS_HOST" ]]; then
    echo "✅ Ingress available at $INGRESS_HOST"
  fi
fi

# 检查数据库连接（通过环境变量）
echo "⏳ Checking service dependencies..."
if kubectl exec -n "$NAMESPACE" "$POD_NAME" -- env | grep -q "NATS_URL"; then
  echo "✅ NATS_URL configured"
fi

if kubectl exec -n "$NAMESPACE" "$POD_NAME" -- env | grep -q "MILVUS"; then
  echo "✅ MILVUS configured"
fi

# 收集部署信息用于日志
echo ""
echo "📊 Deployment Summary:"
echo "Namespace: $NAMESPACE"
echo "Environment: $ENVIRONMENT"
echo "Replicas: $(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.status.replicas}')"
echo "Ready: $(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')"
echo "Updated: $(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.status.updatedReplicas}')"

echo ""
echo "✅ Post-deployment checks completed successfully!"
