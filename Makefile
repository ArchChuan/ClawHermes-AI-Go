.PHONY: build run test lint clean k8s-deploy k8s-delete helm-install helm-uninstall install typecheck test-local

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