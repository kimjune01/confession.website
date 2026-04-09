package main

import (
	"confession-backend/internal/handlers/subscribe"

	"github.com/aws/aws-lambda-go/lambda"
)

func main() { lambda.Start(subscribe.Handler) }
