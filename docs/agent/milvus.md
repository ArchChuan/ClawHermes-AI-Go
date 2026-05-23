# Milvus Development Rules

## SDK Version

Currently using `github.com/milvus-io/milvus-sdk-go/v2` v2.4.2.

## API Call Notes

### Search Method Parameter Order

```go
client.Search(ctx, collectionName, partitions, expr, outputFields, vectors, vectorField, metricType, topK, searchParams)
```

- `searchParams`: use `entity.NewIndexFlatSearchParam()`, returns `(SearchParam, error)`
- Results: use `result.Scores` for scores, not `result.Core`

### Collection Operations

- Must call `LoadCollection` before search
- Call `Flush` after insert to ensure persistence
- Specify schema with primary key field when creating Collection

### Connection Timeout

`pkg/mcp/vector_store.go` uses `net.Dialer` to pre-check port reachability (2s timeout), preventing SDK from blocking indefinitely.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `collection not loaded` | Search before Load | Call `LoadCollection` |
| `field not found` | Schema field name mismatch | Check field definitions in CreateCollection |
| `dimension mismatch` | Vector dim differs from schema | Ensure embedding dim matches Collection definition |

## Migration Notes

When upgrading Milvus SDK version:
1. Check if `Search` API signature changed
2. Check if `entity` package types were renamed
3. Run `go build ./...` to verify compilation
