package pipeline

import (
	"context"

	"github.com/byteBuilderX/stratum/pkg/vector"
)

// MilvusVectorAdapter adapts *vector.VectorStore to the pipeline VectorStore interface.
type MilvusVectorAdapter struct {
	vs *vector.VectorStore
}

// NewMilvusVectorAdapter creates a new adapter wrapping a VectorStore.
func NewMilvusVectorAdapter(vs *vector.VectorStore) *MilvusVectorAdapter {
	return &MilvusVectorAdapter{vs: vs}
}

// Upsert implements VectorStore by delegating to the underlying Milvus Insert.
func (a *MilvusVectorAdapter) Upsert(ctx context.Context, tenantID string, id string, vec []float32, metadata map[string]any) error {
	collectionName := "memory_" + tenantID
	doc := vector.DocumentChunk{
		ID:             id,
		Content:        metadataString(metadata, "content"),
		SourceDocument: metadataString(metadata, "conversation_id"),
		ChunkIndex:     0,
		Vector:         vec,
	}
	return a.vs.Insert(ctx, collectionName, []vector.DocumentChunk{doc})
}

func metadataString(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
