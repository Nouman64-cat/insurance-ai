# Insurance AI AWS infrastructure

This Terraform stack provisions the AWS host foundation in an allowed European region. The defaults select Europe (Milan), `eu-south-1`, and a Graviton EC2 instance. It does not clone the repository, deploy containers, provision PostgreSQL, configure a domain/TLS certificate, or populate application secrets.

## Requirements covered

- `m8g.4xlarge` by default: AWS Graviton4, 16 vCPUs, and 64 GiB memory. Larger M-family Graviton sizes are allowed.
- An encrypted 150 GiB gp3 root EBS volume by default. Terraform retains this volume if the EC2 instance is terminated; preserve it and snapshot it before recovery or decommissioning.
- EC2, a VPC, one public subnet, an internet gateway, and a stable Elastic IP. Terraform selects an AZ where the configured instance type is offered, or validates the explicit `availability_zone` override.
- SSM Session Manager access through an instance role. The security group has no SSH ingress; HTTP/HTTPS ingress is empty by default.
- Optional private application S3 bucket with public access blocked, versioning, server-side encryption, and TLS-only bucket policy. The EC2 role is scoped to this bucket.

This is a single-instance foundation, not a high-availability or autoscaling architecture. One EC2 instance is a single point of failure. The Elastic IP, public subnet, data egress, NAT-free package installation, EC2 runtime, EBS, and S3 incur AWS charges. Review current prices in the account before applying.

## Prerequisites

1. Install Terraform CLI 1.6 or later, AWS CLI v2, and configure AWS credentials locally with permission to manage the resources in this stack. Terraform uses the standard AWS credential chain; credentials are not declared in HCL.
2. Check the account's EC2 quota for at least 16 vCPUs in `eu-south-1`, and verify M8g capacity is available in one of the listed AZs. An AZ offering does not guarantee on-demand capacity at apply time.
3. Review the region and resource plan. Do not apply until the required external services, secret values, and intended web entry point have been decided.

## Initialize and review

Run these commands from `infrastructure/terraform/`:

```powershell
Copy-Item environments/staging.tfvars.example staging.tfvars
terraform init
terraform workspace new staging
terraform fmt -recursive
terraform validate
terraform plan -var-file=staging.tfvars
```

On later runs, replace `terraform workspace new staging` with `terraform workspace select staging`. Use a separate `production` workspace and a separately copied `production.tfvars` for production; never use one workspace for both environments. Edit the local tfvars files as needed. These local files and Terraform state are ignored by the Terraform directory's `.gitignore`; never commit them. The example tfvars files contain no credentials. Terraform state can still contain infrastructure metadata and must be stored and backed up securely. For a team, configure a separately bootstrapped, encrypted remote state backend with locking before collaborating.

`terraform apply -var-file=staging.tfvars` creates billable resources. `terraform destroy` deletes managed resources such as the instance and S3 bucket, but the root EBS disk is retained by EC2's delete-on-termination setting and may continue to incur charges. Back up important data, then manually manage the retained volume after destroy.

## Access the instance

After apply, run the `ssm_session_command` output. The host has no SSH key, and the security group has no inbound rule unless trusted CIDRs are explicitly added to `allowed_web_ingress_cidrs`. SSM requires the instance to reach the regional SSM endpoints; this public-subnet design gives it outbound internet access.

The `user_data.sh` script installs Docker Engine, the Compose v2 plugin, Git, and the SSM agent, and creates `/srv/insurance-ai`. Bootstrap status/logs are in `/var/lib/insurance-ai-bootstrap-complete` and `/var/log/insurance-ai-bootstrap.log`. Check the EC2 system log and SSM managed-node status if bootstrap or SSM registration fails.

## Application deployment prerequisites and known integration work

The production Compose overlay, Caddy TLS reverse proxy, environment template and runbook are in [`deploy/README.md`](../../deploy/README.md). The root `docker-compose.yml` remains development-oriented; use the documented overlay command, not the base file by itself. Terraform deliberately does not clone the repository, deploy containers, provision PostgreSQL, configure DNS, or populate application secrets.

Before serving real customer data, complete the production limitations in that runbook, especially provisioning and securing PostgreSQL, configuring secrets, verifying all ARM64 images/dependencies, and restricting tenant-service's credentialed CORS policy. The S3-consuming services currently pass static AWS keys into boto3, so they do not automatically use the EC2 role; the role/bucket are not ready as a replacement until the application is updated and verified. SES still requires SMTP credentials and a verified sender. The audit archive uses self-hosted MinIO AIStor with separate credentials and key material; it is not wired to the Terraform S3 bucket. Complete and test database migrations, audit key initialization, encrypted off-host backups, and restoration before live use.

## Variables

Environment values belong in ignored local `*.tfvars` files or approved CI variables, not in shared `.env` application files. Use the checked-in `environments/*.tfvars.example` files as non-secret starting points. AWS authentication should come from an AWS profile, environment credentials in CI, or the platform's identity provider.

Useful variables include `aws_region`, `environment`, `instance_type`, `root_volume_size_gib`, `availability_zone`, `allowed_web_ingress_cidrs`, and `create_app_s3_bucket`. Terraform validations reject non-European regions, undersized volumes, and instance sizes below the selected M-family Graviton baseline.
