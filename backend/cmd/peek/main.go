package main

import (
	"confession-backend/internal/handlers/peek"

	"github.com/aws/aws-lambda-go/lambda"
)

func main() { lambda.Start(peek.Handler) }
