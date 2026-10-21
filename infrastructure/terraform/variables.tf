variable "aws_region" {
  description = "AWS region for the stack. Milan is the default European region selected for proximity to Pakistan."
  type        = string
  default     = "eu-south-1"

  validation {
    condition     = startswith(var.aws_region, "eu-")
    error_message = "Choose an AWS Europe region; India and non-European regions are outside this deployment's scope."
  }
}

variable "name_prefix" {
  description = "Short lowercase prefix used in resource names and the generated S3 bucket name."
  type        = string
  default     = "insurance-ai"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,27}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3-29 lowercase letters, numbers, or hyphens, and start/end with a letter or number."
  }
}

variable "environment" {
  description = "Deployment environment name used for resource tags and names."
  type        = string
  default     = "staging"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase letters, numbers, or hyphens and start with a letter."
  }
}

variable "instance_type" {
  description = "M-family Graviton instance with at least 16 vCPUs and 64 GiB memory."
  type        = string
  default     = "m8g.4xlarge"

  validation {
    condition     = can(regex("^m[0-9]+g\\.(4xlarge|8xlarge|12xlarge|16xlarge|24xlarge|48xlarge|metal-[0-9]+xl)$", var.instance_type))
    error_message = "instance_type must be an M-family Graviton size of 4xlarge or larger to meet the minimum compute requirements."
  }
}

variable "availability_zone" {
  description = "Optional AZ override. If empty, Terraform selects an AZ in this region that offers the selected EC2 type."
  type        = string
  default     = ""
}

variable "root_volume_size_gib" {
  description = "Encrypted gp3 root EBS volume size. Kept after instance termination for recovery."
  type        = number
  default     = 150

  validation {
    condition     = var.root_volume_size_gib >= 150 && var.root_volume_size_gib <= 16384
    error_message = "root_volume_size_gib must be between 150 and 16384 GiB."
  }
}

variable "allowed_web_ingress_cidrs" {
  description = "CIDR blocks allowed to reach ports 80 and 443. Empty (the default) leaves the instance reachable only through SSM."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.allowed_web_ingress_cidrs : can(cidrnetmask(cidr))])
    error_message = "Every allowed_web_ingress_cidrs entry must be a valid IPv4 CIDR block."
  }
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for the single-instance VPC."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "public_subnet_cidr" {
  description = "IPv4 CIDR for the public subnet containing the EC2 host."
  type        = string
  default     = "10.40.1.0/24"

  validation {
    condition     = can(cidrnetmask(var.public_subnet_cidr))
    error_message = "public_subnet_cidr must be a valid IPv4 CIDR block."
  }
}

variable "create_app_s3_bucket" {
  description = "Create a private, versioned, encrypted S3 bucket for application artifacts."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags to apply to all supported resources."
  type        = map(string)
  default     = {}
}
