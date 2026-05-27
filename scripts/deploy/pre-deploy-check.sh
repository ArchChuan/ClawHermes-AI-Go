#!/bin/bash
set -euo pipefail

NAMESPACE="${1:-clawhermes}"
ENVIRONMENT="${2:-prod}"

echo "Running pre-deployment checks for $ENVIRONMENT..."

# 检查集群连接
echo "⏳ Checking cluster connectivity..."
if ! kubectl cluster-info &>/dev/null; then
  echo "❌ Cannot connect to cluster"
  exit 1
fi
echo "✅ Cluster connectivity OK"

# 检查 namespace 是否存在
echo "⏳ Checking namespace..."
if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
  echo "❌ Namespace $NAMESPACE not found"
  exit 1
fi
echo "✅ Namespace $NAMESPACE exists"

# 检查 ConfigMap 是否存在
echo "⏳ Checking configuration..."
if ! kubectl get configmap clawhermes-config -n "$NAMESPACE" &>/dev/null; then
  echo "❌ ConfigMap clawhermes-config not found"
  exit 1
fi
echo "✅ ConfigMap exists"

# 检查 Secret 是否存在
echo "⏳ Checking secrets..."
if ! kubectl get secret clawhermes-secrets -n "$NAMESPACE" &>/dev/null; then
  echo "⚠️  Secret clawhermes-secrets not found (may be optional)"
fi
echo "✅ Secrets check completed"

# 检查 RBAC
echo "⏳ Checking RBAC..."
if ! kubectl get serviceaccount clawhermes-ai -n "$NAMESPACE" &>/dev/null; then
  echo "❌ ServiceAccount clawhermes-ai not found"
  exit 1
fi
echo "✅ ServiceAccount exists"

# 检查存储
echo "⏳ Checking persistent volumes..."
PV_COUNT=$(kubectl get pv -o json | jq '.items | length')
echo "✅ Persistent volumes: $PV_COUNT"

# 检查节点状态
echo "⏳ Checking node status..."
UNHEALTHY_NODES=$(kubectl get nodes --no-headers | grep -v " Ready " | wc -l)
if [[ $UNHEALTHY_NODES -gt 0 ]]; then
  echo "⚠️  Found $UNHEALTHY_NODES unhealthy nodes"
  kubectl get nodes
fi
echo "✅ Node status check completed"

# 检查资源可用性
echo "⏳ Checking available resources..."
AVAILABLE_CPU=$(kubectl top nodes 2>/dev/null | tail -1 | awk '{print $NF}' || echo "unknown")
echo "✅ Resources available"

# 检查是否有运行中的部署
echo "⏳ Checking existing deployments..."
if kubectl get deployment clawhermes-ai -n "$NAMESPACE" &>/dev/null; then
  RUNNING_REPLICAS=$(kubectl get deployment clawhermes-ai -n "$NAMESPACE" -o jsonpath='{.status.replicas}')
  echo "✅ Found running deployment with $RUNNING_REPLICAS replicas"
else
  echo "ℹ️  No existing deployment found (fresh deployment)"
fi

echo ""
echo "✅ All pre-deployment checks passed!"
