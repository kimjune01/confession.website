// Pattern from ephemeral.website/backend/internal/response.go
// as of commit aa37e846ecfb38efddba75ffc28707bfbd0a004d.
package internal

import (
	"encoding/json"

	"github.com/aws/aws-lambda-go/events"
)

func JSON(status int, body any) events.APIGatewayV2HTTPResponse {
	b, _ := json.Marshal(body)
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       string(b),
	}
}

func NotFound() events.APIGatewayV2HTTPResponse {
	return JSON(404, map[string]any{})
}

func Error(status int, msg string) events.APIGatewayV2HTTPResponse {
	return JSON(status, map[string]string{"error": msg})
}
