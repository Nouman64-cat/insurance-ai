output "aws_region" {
  description = "AWS region hosting this environment."
  value       = var.aws_region
}

output "availability_zone" {
  description = "AZ selected for this environment; it offers the configured Graviton type."
  value       = local.selected_availability_zone
}

output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.app.id
}

output "instance_type" {
  description = "EC2 Graviton instance type."
  value       = aws_instance.app.instance_type
}

output "root_volume_size_gib" {
  description = "Encrypted gp3 root volume size. The volume is retained when the instance is terminated."
  value       = var.root_volume_size_gib
}

output "public_ipv4" {
  description = "Elastic IPv4 address; use it for external dependency allowlists and eventual DNS."
  value       = aws_eip.app.public_ip
}

output "app_s3_bucket_name" {
  description = "Private, versioned application S3 bucket. Empty if create_app_s3_bucket is false."
  value       = var.create_app_s3_bucket ? aws_s3_bucket.app[0].bucket : ""
}

output "ssm_session_command" {
  description = "Command to open a shell through AWS Systems Manager; no SSH key or inbound SSH is configured."
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.aws_region}"
}
