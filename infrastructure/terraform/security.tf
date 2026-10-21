locals {
  web_ingress_rules = {
    for rule in setproduct(var.allowed_web_ingress_cidrs, toset([80, 443])) :
    "${replace(rule[0], "/", "_")}-${rule[1]}" => {
      cidr = rule[0]
      port = rule[1]
    }
  }
}

resource "aws_security_group" "instance" {
  name        = "${var.name_prefix}-${var.environment}-instance"
  description = "Insurance AI EC2; no SSH ingress, optional web ingress only."
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = local.web_ingress_rules
    content {
      description = "Web ${ingress.value.port} from ${ingress.value.cidr}"
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = [ingress.value.cidr]
    }
  }

  egress {
    description = "Outbound access for updates, SSM, and application dependencies"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-instance-sg" }
}
