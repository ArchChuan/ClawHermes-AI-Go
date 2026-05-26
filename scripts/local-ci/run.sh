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

print_section() {
  echo ""
  echo -e "${YELLOW}========== $1 ==========${NC}"
  echo ""
}

# 记录开始时间
START_TIME=$(date +%s)

# 阶段 1: 类型检查
print_section "1. 类型检查"
if ! make typecheck; then
  print_error "类型检查失败"
  exit 1
fi
print_success "类型检查通过"

# 阶段 2: Lint 检查
print_section "2. Lint 检查"
if ! make lint; then
  print_error "Lint 检查失败"
  exit 1
fi
print_success "Lint 检查通过"

# 阶段 3: 安全扫描
print_section "3. 安全扫描"
if ! make security-scan; then
  print_error "安全扫描失败"
  exit 1
fi
print_success "安全扫描通过"

# 阶段 4: 本地测试
print_section "4. 本地测试"
if ! make test-local; then
  print_error "本地测试失败"
  exit 1
fi
print_success "本地测试通过"

# 阶段 5: 全量测试
print_section "5. 全量测试"
if ! make test-full; then
  print_error "全量测试失败"
  exit 1
fi
print_success "全量测试通过"

# 计算总耗时
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
MINUTES=$((DURATION / 60))
SECONDS=$((DURATION % 60))

echo ""
print_success "CI 检查全部通过！"
echo "总耗时: ${MINUTES}m${SECONDS}s"
