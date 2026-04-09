package main

import (
	"confession-backend/internal/handlers/compose"

	"github.com/aws/aws-lambda-go/lambda"
)

func main() { lambda.Start(compose.Handler) }
