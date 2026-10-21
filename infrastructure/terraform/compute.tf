data "aws_ssm_parameter" "ubuntu_arm64_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.ubuntu_arm64_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = true
  monitoring                  = true
  ebs_optimized               = true
  user_data                   = file("${path.module}/user_data.sh")

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    encrypted             = true
    delete_on_termination = false
    iops                  = 3000
    throughput            = 125
  }

  volume_tags = {
    Name = "${var.name_prefix}-${var.environment}-root"
  }

  lifecycle {
    precondition {
      condition     = data.aws_ec2_instance_type.selected.memory_size >= 65536
      error_message = "${var.instance_type} must provide at least 64 GiB of memory."
    }
    precondition {
      condition     = data.aws_ec2_instance_type.selected.default_vcpus >= 16
      error_message = "${var.instance_type} must provide at least 16 vCPUs."
    }
    precondition {
      condition     = contains(data.aws_ec2_instance_type.selected.supported_architectures, "arm64")
      error_message = "${var.instance_type} must support the ARM64 architecture for AWS Graviton."
    }
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-app" }
}

data "aws_ec2_instance_type" "selected" {
  instance_type = var.instance_type
}

resource "aws_eip" "app" {
  domain = "vpc"

  tags = { Name = "${var.name_prefix}-${var.environment}-app-eip" }
}

resource "aws_eip_association" "app" {
  allocation_id = aws_eip.app.id
  instance_id   = aws_instance.app.id
}
