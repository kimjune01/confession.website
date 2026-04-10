// Pulumi Go program for confession.website.
//
// Shape mirrors ../ephemeral.website/infra/main.go: S3 + DynamoDB +
// Lambda-per-handler + API Gateway HTTP API + Route53 + ACM. Differences:
//
//   - One DDB table with composite key (PK string, SK string). META and
//     SUB# items both live under `slug#<id>` partitions. DDB TTL on
//     `expires_at`, same attribute name for both item types.
//   - Five API Lambdas (compose, probe, listen, rally_compose, subscribe)
//     plus a catch-all site Lambda.
//   - S3 lifecycle at 8 days on the `audio/` prefix — one day past DDB TTL
//     so orphan blobs left by any crash are still swept.
//   - CORS allowlist matches ephemeral's .website family.
package main

import (
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/acm"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/apigatewayv2"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/dynamodb"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/lambda"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/route53"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/s3"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

const domain = "confession.website"

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		// ── S3: audio storage ──
		audioBucket, err := s3.NewBucket(ctx, "confession-audio", &s3.BucketArgs{
			ForceDestroy: pulumi.Bool(true),
			LifecycleRules: s3.BucketLifecycleRuleArray{
				&s3.BucketLifecycleRuleArgs{
					Enabled: pulumi.Bool(true),
					Prefix:  pulumi.String("audio/"),
					Expiration: &s3.BucketLifecycleRuleExpirationArgs{
						Days: pulumi.Int(8),
					},
				},
			},
		})
		if err != nil {
			return err
		}

		// ── DynamoDB: single META table ──
		// Composite key. META items: SK = "META". Push sub items:
		// SK = "SUB#<endpoint_hash>". DDB TTL on expires_at drops
		// both independently.
		metaTable, err := dynamodb.NewTable(ctx, "confession-meta", &dynamodb.TableArgs{
			BillingMode: pulumi.String("PAY_PER_REQUEST"),
			HashKey:     pulumi.String("PK"),
			RangeKey:    pulumi.String("SK"),
			Attributes: dynamodb.TableAttributeArray{
				&dynamodb.TableAttributeArgs{
					Name: pulumi.String("PK"),
					Type: pulumi.String("S"),
				},
				&dynamodb.TableAttributeArgs{
					Name: pulumi.String("SK"),
					Type: pulumi.String("S"),
				},
			},
			Ttl: &dynamodb.TableTtlArgs{
				AttributeName: pulumi.String("expires_at"),
				Enabled:       pulumi.Bool(true),
			},
		})
		if err != nil {
			return err
		}

		// ── IAM ──
		lambdaRole, err := iam.NewRole(ctx, "confession-lambda-role", &iam.RoleArgs{
			AssumeRolePolicy: pulumi.String(`{
				"Version": "2012-10-17",
				"Statement": [{
					"Action": "sts:AssumeRole",
					"Principal": {"Service": "lambda.amazonaws.com"},
					"Effect": "Allow"
				}]
			}`),
		})
		if err != nil {
			return err
		}

		_, err = iam.NewRolePolicyAttachment(ctx, "lambda-basic", &iam.RolePolicyAttachmentArgs{
			Role:      lambdaRole.Name,
			PolicyArn: pulumi.String("arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"),
		})
		if err != nil {
			return err
		}

		_, err = iam.NewRolePolicy(ctx, "lambda-app-policy", &iam.RolePolicyArgs{
			Role: lambdaRole.ID(),
			Policy: pulumi.All(audioBucket.Arn, metaTable.Arn).ApplyT(
				func(args []interface{}) string {
					bucketArn := args[0].(string)
					metaArn := args[1].(string)
					return `{
						"Version": "2012-10-17",
						"Statement": [
							{
								"Effect": "Allow",
								"Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
								"Resource": "` + bucketArn + `/*"
							},
							{
								"Effect": "Allow",
								"Action": [
									"dynamodb:GetItem",
									"dynamodb:PutItem",
									"dynamodb:UpdateItem",
									"dynamodb:DeleteItem",
									"dynamodb:Query"
								],
								"Resource": "` + metaArn + `"
							}
						]
					}`
				},
			).(pulumi.StringOutput),
		})
		if err != nil {
			return err
		}

		// ── Lambda functions ──
		lambdaEnv := &lambda.FunctionEnvironmentArgs{
			Variables: pulumi.StringMap{
				"META_TABLE":   metaTable.Name,
				"AUDIO_BUCKET": audioBucket.ID(),
			},
		}

		goRuntime := pulumi.String("provided.al2023")
		goArch := pulumi.String("arm64")
		goHandler := pulumi.String("bootstrap")

		newFn := func(name string, timeout int) (*lambda.Function, error) {
			return lambda.NewFunction(ctx, "confession-"+name, &lambda.FunctionArgs{
				Runtime:       goRuntime,
				Handler:       goHandler,
				Architectures: pulumi.StringArray{goArch},
				Role:          lambdaRole.Arn,
				Code:          pulumi.NewFileArchive("../backend/dist/" + name),
				Environment:   lambdaEnv,
				Timeout:       pulumi.Int(timeout),
				MemorySize:    pulumi.Int(128),
			})
		}

		composeFn, err := newFn("compose", 10)
		if err != nil {
			return err
		}
		probeFn, err := newFn("probe", 5)
		if err != nil {
			return err
		}
		listenFn, err := newFn("listen", 10)
		if err != nil {
			return err
		}
		rallyFn, err := newFn("rally_compose", 10)
		if err != nil {
			return err
		}
		subscribeFn, err := newFn("subscribe", 5)
		if err != nil {
			return err
		}

		// Site Lambda has no DB/S3 access — no env needed.
		siteFn, err := lambda.NewFunction(ctx, "confession-site", &lambda.FunctionArgs{
			Runtime:       goRuntime,
			Handler:       goHandler,
			Architectures: pulumi.StringArray{goArch},
			Role:          lambdaRole.Arn,
			Code:          pulumi.NewFileArchive("../backend/dist/site"),
			Timeout:       pulumi.Int(5),
			MemorySize:    pulumi.Int(128),
		})
		if err != nil {
			return err
		}

		// ── ACM certificate ──
		cert, err := acm.NewCertificate(ctx, "confession-cert", &acm.CertificateArgs{
			DomainName:       pulumi.String(domain),
			ValidationMethod: pulumi.String("DNS"),
		})
		if err != nil {
			return err
		}

		// ── Route53 hosted zone ──
		zone, err := route53.NewZone(ctx, "confession-zone", &route53.ZoneArgs{
			Name: pulumi.String(domain),
		})
		if err != nil {
			return err
		}

		validationRecord, err := route53.NewRecord(ctx, "confession-cert-validation", &route53.RecordArgs{
			ZoneId: zone.ZoneId,
			Name:   cert.DomainValidationOptions.Index(pulumi.Int(0)).ResourceRecordName().Elem(),
			Type:   cert.DomainValidationOptions.Index(pulumi.Int(0)).ResourceRecordType().Elem(),
			Records: pulumi.StringArray{
				cert.DomainValidationOptions.Index(pulumi.Int(0)).ResourceRecordValue().Elem(),
			},
			Ttl: pulumi.Int(60),
		})
		if err != nil {
			return err
		}

		certValidation, err := acm.NewCertificateValidation(ctx, "confession-cert-valid", &acm.CertificateValidationArgs{
			CertificateArn:        cert.Arn,
			ValidationRecordFqdns: pulumi.StringArray{validationRecord.Fqdn},
		})
		if err != nil {
			return err
		}

		// ── API Gateway ──
		api, err := apigatewayv2.NewApi(ctx, "confession-api", &apigatewayv2.ApiArgs{
			ProtocolType: pulumi.String("HTTP"),
			// Public API, restricted to the .website family of
			// first-party layers. HTTP API doesn't support glob
			// patterns in CORS origins, so new layers must be
			// added here and redeployed.
			CorsConfiguration: &apigatewayv2.ApiCorsConfigurationArgs{
				AllowOrigins: pulumi.StringArray{
					pulumi.String("https://confession.website"),
					pulumi.String("https://ephemeral.website"),
					pulumi.String("https://appreciation.website"),
				},
				AllowMethods: pulumi.StringArray{
					pulumi.String("GET"),
					pulumi.String("POST"),
					pulumi.String("OPTIONS"),
				},
				AllowHeaders: pulumi.StringArray{
					pulumi.String("Content-Type"),
				},
				MaxAge: pulumi.Int(300),
			},
		})
		if err != nil {
			return err
		}

		_, err = apigatewayv2.NewStage(ctx, "confession-stage", &apigatewayv2.StageArgs{
			ApiId:      api.ID(),
			Name:       pulumi.String("$default"),
			AutoDeploy: pulumi.Bool(true),
		})
		if err != nil {
			return err
		}

		// Custom domain
		domainName, err := apigatewayv2.NewDomainName(ctx, "confession-domain", &apigatewayv2.DomainNameArgs{
			DomainName: pulumi.String(domain),
			DomainNameConfiguration: &apigatewayv2.DomainNameDomainNameConfigurationArgs{
				CertificateArn: certValidation.CertificateArn,
				EndpointType:   pulumi.String("REGIONAL"),
				SecurityPolicy: pulumi.String("TLS_1_2"),
			},
		})
		if err != nil {
			return err
		}

		_, err = apigatewayv2.NewApiMapping(ctx, "confession-mapping", &apigatewayv2.ApiMappingArgs{
			ApiId:      api.ID(),
			DomainName: domainName.ID(),
			Stage:      pulumi.String("$default"),
		})
		if err != nil {
			return err
		}

		_, err = route53.NewRecord(ctx, "confession-dns", &route53.RecordArgs{
			ZoneId: zone.ZoneId,
			Name:   pulumi.String(domain),
			Type:   pulumi.String("A"),
			Aliases: route53.RecordAliasArray{
				&route53.RecordAliasArgs{
					Name:                 domainName.DomainNameConfiguration.TargetDomainName().Elem(),
					ZoneId:               domainName.DomainNameConfiguration.HostedZoneId().Elem(),
					EvaluateTargetHealth: pulumi.Bool(false),
				},
			},
		})
		if err != nil {
			return err
		}

		// ── API routes ──
		apiRoutes := []struct {
			name   string
			method string
			path   string
			fn     *lambda.Function
		}{
			{"compose", "POST", "/api/compose", composeFn},
			{"probe", "GET", "/api/slug/{slug}", probeFn},
			{"listen", "POST", "/api/slug/{slug}/listen", listenFn},
			{"rally-compose", "POST", "/api/slug/{slug}/compose", rallyFn},
			{"subscribe", "POST", "/api/slug/{slug}/subscribe", subscribeFn},
		}

		for _, r := range apiRoutes {
			integration, err := apigatewayv2.NewIntegration(ctx, "integration-"+r.name, &apigatewayv2.IntegrationArgs{
				ApiId:                api.ID(),
				IntegrationType:      pulumi.String("AWS_PROXY"),
				IntegrationUri:       r.fn.Arn,
				PayloadFormatVersion: pulumi.String("2.0"),
			})
			if err != nil {
				return err
			}

			_, err = apigatewayv2.NewRoute(ctx, "route-"+r.name, &apigatewayv2.RouteArgs{
				ApiId:    api.ID(),
				RouteKey: pulumi.Sprintf("%s %s", r.method, r.path),
				Target:   integration.ID().ApplyT(func(id string) string { return "integrations/" + id }).(pulumi.StringOutput),
			})
			if err != nil {
				return err
			}

			_, err = lambda.NewPermission(ctx, "permission-"+r.name, &lambda.PermissionArgs{
				Action:    pulumi.String("lambda:InvokeFunction"),
				Function:  r.fn.Name,
				Principal: pulumi.String("apigateway.amazonaws.com"),
				SourceArn: api.ExecutionArn.ApplyT(func(arn string) string { return arn + "/*/*" }).(pulumi.StringOutput),
			})
			if err != nil {
				return err
			}
		}

		// Site catch-all ($default route — lowest priority)
		siteIntegration, err := apigatewayv2.NewIntegration(ctx, "integration-site", &apigatewayv2.IntegrationArgs{
			ApiId:                api.ID(),
			IntegrationType:      pulumi.String("AWS_PROXY"),
			IntegrationUri:       siteFn.Arn,
			PayloadFormatVersion: pulumi.String("2.0"),
		})
		if err != nil {
			return err
		}

		_, err = apigatewayv2.NewRoute(ctx, "route-site", &apigatewayv2.RouteArgs{
			ApiId:    api.ID(),
			RouteKey: pulumi.String("$default"),
			Target:   siteIntegration.ID().ApplyT(func(id string) string { return "integrations/" + id }).(pulumi.StringOutput),
		})
		if err != nil {
			return err
		}

		_, err = lambda.NewPermission(ctx, "permission-site", &lambda.PermissionArgs{
			Action:    pulumi.String("lambda:InvokeFunction"),
			Function:  siteFn.Name,
			Principal: pulumi.String("apigateway.amazonaws.com"),
			SourceArn: api.ExecutionArn.ApplyT(func(arn string) string { return arn + "/*/*" }).(pulumi.StringOutput),
		})
		if err != nil {
			return err
		}

		// ── Exports ──
		ctx.Export("apiUrl", api.ApiEndpoint)
		ctx.Export("audioBucket", audioBucket.ID())
		ctx.Export("metaTable", metaTable.Name)
		ctx.Export("nameServers", zone.NameServers)

		return nil
	})
}
