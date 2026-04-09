package main

import (
	"confession-backend/internal/handlers/probe"

	"github.com/aws/aws-lambda-go/lambda"
)

func main() { lambda.Start(probe.Handler) }
