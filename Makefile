.PHONY: build run test lint clean k8s-deploy k8s-delete helm-install helm-uninstall install typecheck test-local \
	minikube-start minikube-stop minikube-status minikube-clean \
	local-ci local-deploy local-verify local-rollback \
	docker-build docker-push local-pipeline

# 5 条项目命令规范

# 1. 安装依赖
install:
	@echo "📦 安装项目依赖..."
	go mod download
	go mod tidy
	@echo "✓ 依赖安装完成"

# 2. 类型检查
typecheck:
	@echo "🔍 执行类型检查..."
	go vet ./...
	@echo "✓ 类型检查通过"

# 3. Lint 检查
lint:
	@echo "🎯 执行代码检查..."
	@command -v golangci-lint >/dev/null 2>&1 || (echo "❌ golangci-lint 未安装，请运行: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest" && exit 1)
	golangci-lint run ./... --timeout=5m
	@echo "✓ 代码检查通过"

# 4. 局部测试（快速测试）
test-local:
	@echo "🧪 执行局部测试..."
	go test -v -short ./... -timeout=30s
	@echo "✓ 局部测试通过"

# 5. 全量测试
test-full:
	@echo "🧪 执行全量测试..."
	go test -v -race -coverprofile=coverage.out ./... -timeout=5m
	go tool cover -func=coverage.out | tail -1
	@echo "✓ 全量测试通过"

build:
	go build -o bin/server ./cmd/server

run:
	go run ./cmd/server

# 预提交检查
pre-commit:
	@echo "🔍 执行预提交检查..."
	pre-commit run --all-files
	@echo "✓ 预提交检查通过"

# 安全扫描
security-scan:
	@echo "🛡️ 执行安全扫描..."
	semgrep --config=p/security-audit --config=p/go ./...
	@echo "✓ 安全扫描完成"

# 代码格式化
fmt:
	@echo "📝 格式化代码..."
	go fmt ./...
	gofmt -s -w .
	@echo "✓ 代码格式化完成"

# 依赖审计
audit:
	@echo "🔐 审计依赖..."
	go list -json -m all | nancy sleuth
	@echo "✓ 依赖审计完成"

# 生成文档
docs:
	@echo "📚 生成文档..."
	godoc -http=:6060
	@echo "✓ 文档已生成，访问 http://localhost:6060"

# 性能基准测试
bench:
	@echo "⚡ 执行基准测试..."
	go test -bench=. -benchmem ./...
	@echo "✓ 基准测试完成"

# 完整检查（所有检查）
check-all: install typecheck lint security-scan test-full
	@echo "✅ 所有检查通过"

test:
	go test -v ./...

test-coverage:
	go test -v -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out

vet:
	go vet ./...

# Container targets
docker-build:
	docker build -t clawhermes-ai-go:latest .

docker-run:
	docker run -p 8080:8080 clawhermes-ai-go:latest

# Kubernetes targets
k8s-deploy:
	kubectl apply -f k8s/security.yaml
	kubectl apply -f k8s/dependencies.yaml
	kubectl apply -f k8s/monitoring.yaml
	kubectl apply -f k8s/deployment.yaml

k8s-delete:
	kubectl delete -f k8s/deployment.yaml
	kubectl delete -f k8s/monitoring.yaml
	kubectl delete -f k8s/dependencies.yaml
	kubectl delete -f k8s/security.yaml

# Helm targets
helm-install:
	kubectl create namespace clawhermes-system --dry-run=client -o yaml | kubectl apply -f -
	helm install clawhermes-release ./helm -f helm/values.yaml -n clawhermes-system

helm-uninstall:
	helm uninstall clawhermes-release -n clawhermes-system

# Clean target
clean:
	rm -rf bin/
	rm -f coverage.out

# ============================================
# 本地 Minikube 环境管理
# ============================================

minikube-start:
	@echo "🚀 启动 Minikube..."
	@bash scripts/minikube/start.sh

minikube-stop:
	@echo "⏹️  停止 Minikube..."
	minikube stop

minikube-status:
	@echo "📊 Minikube 状态..."
	minikube status
	@echo ""
	@echo "📦 Pods 状态:"
	kubectl get pods -n clawhermes --no-headers 2>/dev/null || echo "clawhermes namespace 未就绪"

minikube-clean:
	@echo "🗑️  清理 Minikube..."
	minikube delete
	@echo "✓ Minikube 已删除"

minikube-shell:
	@echo "🔌 进入 Minikube 容器..."
	minikube ssh

minikube-logs:
	@echo "📋 Minikube 日志..."
	minikube logs --tail=50

# ============================================
# 本地 Docker 镜像构建
# ============================================

docker-build:
	@echo "🐳 构建 Docker 镜像..."
	docker build -t clawhermes-ai-go:local -f Dockerfile .
	@echo "✓ 镜像构建完成: clawhermes-ai-go:local"

docker-build-minikube:
	@echo "🐳 为 Minikube 构建镜像（使用 Minikube Docker）..."
	@eval $$(minikube docker-env) && docker build -t clawhermes-ai-go:local -f Dockerfile .
	@echo "✓ 镜像已推送到 Minikube: clawhermes-ai-go:local"

docker-run:
	@echo "🚀 运行 Docker 容器..."
	docker run -p 8080:8080 clawhermes-ai-go:local

# ============================================
# 本地 CI/CD 流程
# ============================================

local-pipeline: typecheck lint security-scan test-full docker-build-minikube local-deploy local-verify
	@echo "✅ 本地 CI/CD 流程完成！"

local-ci:
	@echo "🔄 运行本地 CI 检查..."
	@bash scripts/local-ci/run.sh

local-deploy:
	@echo "📦 部署到本地 Minikube..."
	@bash scripts/deploy/deploy-local.sh

local-verify:
	@echo "✅ 验证本地部署..."
	@bash scripts/deploy/verify.sh clawhermes dev

local-rollback:
	@echo "⏮️  回滚本地部署..."
	kubectl rollout undo deployment/clawhermes-ai -n clawhermes
	@bash scripts/deploy/verify.sh clawhermes dev

# ============================================
# 开发辅助命令
# ============================================

dev-logs:
	@echo "📋 查看应用日志..."
	kubectl logs -n clawhermes -l app=clawhermes-ai -f --tail=100 2>/dev/null || echo "❌ 无法获取日志"

dev-port-forward:
	@echo "🔌 端口转发..."
	@echo "应用: http://localhost:8080"
	@echo "Prometheus: http://localhost:9090"
	@echo "Grafana: http://localhost:3000"
	@echo "Jaeger: http://localhost:16686"
	kubectl port-forward -n clawhermes svc/clawhermes-ai 8080:80 &
	kubectl port-forward -n clawhermes svc/prometheus 9090:9090 &
	kubectl port-forward -n clawhermes svc/grafana 3000:3000 &
	kubectl port-forward -n clawhermes svc/jaeger 16686:16686 &
	@echo "✓ 端口转发已启动（按 Ctrl+C 停止）"

dev-shell:
	@echo "🔌 进入 Pod shell..."
	@POD=$$(kubectl get pods -n clawhermes -l app=clawhermes-ai -o jsonpath='{.items[0].metadata.name}'); \
	[ -z "$$POD" ] && echo "❌ 无法找到 Pod" && exit 1 || kubectl exec -it $$POD -n clawhermes -- sh

dev-metrics:
	@echo "📊 查看 Pod 资源使用..."
	kubectl top pods -n clawhermes -l app=clawhermes-ai

dev-events:
	@echo "📌 查看最近事件..."
	kubectl get events -n clawhermes --sort-by='.lastTimestamp' | tail -20

dev-describe:
	@echo "📝 查看 Deployment 详情..."
	kubectl describe deployment clawhermes-ai -n clawhermes

# ============================================
# 完整工作流
# ============================================

setup-local:
	@echo "⚙️  设置本地开发环境..."
	@bash scripts/minikube/start.sh
	@bash scripts/deploy/init.sh dev
	@echo "✓ 本地环境设置完成"

full-reset:
	@echo "🔄 完全重置本地环境..."
	@make local-rollback || true
	@make k8s-delete || true
	@make minikube-clean
	@echo "✓ 本地环境已重置"

help-local:
	@echo "📚 本地 CI/CD 命令参考:"
	@echo ""
	@echo "Minikube 管理:"
	@echo "  make minikube-start      - 启动 Minikube"
	@echo "  make minikube-stop       - 停止 Minikube"
	@echo "  make minikube-status     - 查看状态"
	@echo "  make minikube-clean      - 删除 Minikube"
	@echo ""
	@echo "本地 CI/CD:"
	@echo "  make local-pipeline      - 完整 CI/CD 流程"
	@echo "  make local-ci            - 只运行 CI 检查"
	@echo "  make local-deploy        - 部署到 Minikube"
	@echo "  make local-verify        - 验证部署"
	@echo "  make local-rollback      - 回滚部署"
	@echo ""
	@echo "开发辅助:"
	@echo "  make dev-logs            - 查看日志"
	@echo "  make dev-port-forward    - 端口转发"
	@echo "  make dev-shell           - 进入 Pod shell"
	@echo "  make dev-metrics         - 查看资源使用"
	@echo "  make dev-describe        - 查看详情"
	@echo ""
	@echo "快速开始:"
	@echo "  make setup-local         - 初始化本地环境"
	@echo "  make full-reset          - 重置本地环境"
