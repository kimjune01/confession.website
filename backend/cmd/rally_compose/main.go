package main

import (
	rally_compose "confession-backend/internal/handlers/rally_compose"

	"github.com/aws/aws-lambda-go/lambda"
)

func main() { lambda.Start(rally_compose.Handler) }
