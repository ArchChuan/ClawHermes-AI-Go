package handler

import (
	"github.com/byteBuilderX/ClawHermes-AI-Go/pkg/tenantdb"
	"github.com/gin-gonic/gin"
)

func tenantIDFromCtx(c *gin.Context) (string, bool) {
	tc, ok := tenantdb.FromContext(c.Request.Context())
	if !ok || tc.TenantID == "" {
		return "", false
	}
	return tc.TenantID, true
}

func respondMissingTenant(c *gin.Context) {
	c.JSON(401, gin.H{"error": "tenant context required"})
}
