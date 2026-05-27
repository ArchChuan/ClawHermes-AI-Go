#!/bin/bash
set -euo pipefail

NAMESPACE="${1:-clawhermes}"
REVISION="${2:-1}"

echo "Rolling back deployment to revision $REVISION in namespace $NAMESPACE..."

# 列出回滚历史
echo "📜 Rollout history:"
kubectl rollout history deployment/clawhermes-ai -n "$NAMESPACE"

echo ""
echo "⏳ Rolling back to revision $REVISION..."

# 执行回滚
if kubectl rollout undo deployment/clawhermes-ai -n "$NAMESPACE" --to-revision="$REVISION"; then
  echo "✅ Rollback initiated"
else
  echo "❌ Rollback failed"
  exit 1
fi

# 等待回滚完成
echo "⏳ Waiting for rollback to complete..."
if kubectl rollout status deployment/clawhermes-ai -n "$NAMESPACE" --timeout=5m; then
  echo "✅ Rollback completed successfully"
else
  echo "❌ Rollback timed out"
  exit 1
fi

# 验证回滚
echo "⏳ Verifying rollback..."
CURRENT_IMAGE=$(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')
echo "✅ Current image: $CURRENT_IMAGE"

# 健康检查
sleep 5
POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l app=clawhermes-ai -o jsonpath='{.items[0].metadata.name}')
if kubectl exec -n "$NAMESPACE" "$POD_NAME" -- curl -sf http://localhost:8080/health > /dev/null; then
  echo "✅ Health check passed"
else
  echo "❌ Health check failed after rollback"
  exit 1
fi

echo ""
echo "✅ Rollback completed and verified!"
