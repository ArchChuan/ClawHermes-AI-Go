// Package handler implements HTTP API request handlers.

package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/byteBuilderX/ClawHermes-AI-Go/api/model"
	"github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
	"github.com/byteBuilderX/ClawHermes-AI-Go/internal/orchestrator"
	"github.com/byteBuilderX/ClawHermes-AI-Go/internal/skill"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

type configurable interface {
	GetConfig() map[string]any
}

func buildSkillResponse(s skill.Skill, createdAt time.Time) model.SkillResponse {
	resp := model.SkillResponse{
		ID:          s.GetID(),
		Name:        s.GetName(),
		Description: s.GetDescription(),
		Type:        s.GetType(),
		CreatedAt:   createdAt.Format(time.RFC3339),
	}
	if c, ok := s.(configurable); ok {
		resp.Config = c.GetConfig()
	}
	return resp
}

type SkillHandler struct {
	registry *orchestrator.Registry
	logger   *zap.Logger
	gateway  *llmgateway.Gateway
}

func NewSkillHandler(registry *orchestrator.Registry, logger *zap.Logger, gateway *llmgateway.Gateway) *SkillHandler {
	return &SkillHandler{
		registry: registry,
		logger:   logger,
		gateway:  gateway,
	}
}

func (h *SkillHandler) CreateSkill(c *gin.Context) {
	var req model.CreateSkillRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.logger.Warn("invalid request", zap.Error(err))
		c.JSON(http.StatusBadRequest, model.ErrorResponse{
			Code:    http.StatusBadRequest,
			Message: err.Error(),
		})
		return
	}

	id := uuid.New().String()
	var s skill.Skill

	switch req.Type {
	case "code":
		s = skill.NewCodeSkill(id, req.Name, req.Description, req.Code, req.Language)
	case "llm":
		s = skill.NewLLMSkill(id, req.Name, req.Description, req.SystemPrompt, req.Model, req.Temperature, req.MaxTokens, h.gateway, h.logger)
	case "http":
		s = skill.NewHTTPSkill(id, req.Name, req.Description, req.URL, req.Method, req.Headers, req.BodyTemplate, req.TimeoutSec)
	default:
		c.JSON(http.StatusBadRequest, model.ErrorResponse{
			Code:    http.StatusBadRequest,
			Message: "unsupported skill type",
		})
		return
	}

	h.registry.Register(c.Request.Context(), id, s)
	h.logger.Info("skill created", zap.String("id", id), zap.String("name", req.Name))

	createdAt, _ := h.registry.GetCreatedAt(id)
	c.JSON(http.StatusCreated, buildSkillResponse(s, createdAt))
}

func (h *SkillHandler) GetSkill(c *gin.Context) {
	id := c.Param("id")
	s, ok := h.registry.Get(id)
	if !ok {
		h.logger.Warn("skill not found", zap.String("id", id))
		c.JSON(http.StatusNotFound, model.ErrorResponse{
			Code:    http.StatusNotFound,
			Message: "skill not found",
		})
		return
	}

	createdAt, _ := h.registry.GetCreatedAt(id)
	c.JSON(http.StatusOK, buildSkillResponse(s, createdAt))
}

func (h *SkillHandler) GetAllSkills(c *gin.Context) {
	skills := h.registry.GetAll()
	responses := make([]model.SkillResponse, 0, len(skills))
	for _, s := range skills {
		createdAt, _ := h.registry.GetCreatedAt(s.GetID())
		responses = append(responses, buildSkillResponse(s, createdAt))
	}
	c.JSON(http.StatusOK, gin.H{"skills": responses})
}

func (h *SkillHandler) UpdateSkill(c *gin.Context) {
	id := c.Param("id")
	s, ok := h.registry.Get(id)
	if !ok {
		h.logger.Warn("skill not found", zap.String("id", id))
		c.JSON(http.StatusNotFound, model.ErrorResponse{
			Code:    http.StatusNotFound,
			Message: "skill not found",
		})
		return
	}

	var req model.CreateSkillRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.logger.Warn("invalid request", zap.Error(err))
		c.JSON(http.StatusBadRequest, model.ErrorResponse{
			Code:    http.StatusBadRequest,
			Message: err.Error(),
		})
		return
	}

	switch s.GetType() {
	case "code":
		cs, ok := s.(*skill.CodeSkill)
		if !ok {
			c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "type mismatch"})
			return
		}
		cs.Name = req.Name
		cs.Description = req.Description
		cs.Code = req.Code
		cs.Language = req.Language

	case "llm":
		ls, ok := s.(*skill.LLMSkill)
		if !ok {
			c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "type mismatch"})
			return
		}
		ls.Name = req.Name
		ls.Description = req.Description
		ls.SystemPrompt = req.SystemPrompt
		ls.Model = req.Model
		ls.Temperature = req.Temperature
		ls.MaxTokens = req.MaxTokens

	case "http":
		hs, ok := s.(*skill.HTTPSkill)
		if !ok {
			c.JSON(http.StatusBadRequest, model.ErrorResponse{Code: http.StatusBadRequest, Message: "type mismatch"})
			return
		}
		hs.Name = req.Name
		hs.Description = req.Description
		hs.URL = req.URL
		hs.Method = req.Method
		hs.Headers = req.Headers
		hs.BodyTemplate = req.BodyTemplate
		hs.TimeoutSec = req.TimeoutSec

	default:
		c.JSON(http.StatusBadRequest, model.ErrorResponse{
			Code:    http.StatusBadRequest,
			Message: "unsupported skill type",
		})
		return
	}

	h.registry.Register(c.Request.Context(), id, s)
	h.logger.Info("skill updated", zap.String("id", id))
	createdAt, _ := h.registry.GetCreatedAt(id)
	c.JSON(http.StatusOK, buildSkillResponse(s, createdAt))
}

func (h *SkillHandler) DeleteSkill(c *gin.Context) {
	id := c.Param("id")
	if err := h.registry.Remove(c.Request.Context(), id); err != nil {
		if errors.Is(err, orchestrator.ErrSkillInUse) {
			c.JSON(http.StatusConflict, model.ErrorResponse{
				Code:    http.StatusConflict,
				Message: err.Error(),
			})
			return
		}
		h.logger.Warn("skill not found or removal failed", zap.String("id", id), zap.Error(err))
		c.JSON(http.StatusNotFound, model.ErrorResponse{
			Code:    http.StatusNotFound,
			Message: "skill not found",
		})
		return
	}
	h.logger.Info("skill deleted", zap.String("id", id))
	c.JSON(http.StatusOK, gin.H{"message": "skill deleted successfully"})
}
