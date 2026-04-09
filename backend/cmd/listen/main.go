package main

import (
	"confession-backend/internal/handlers/listen"

	"github.com/aws/aws-lambda-go/lambda"
)

func main() { lambda.Start(listen.Handler) }
