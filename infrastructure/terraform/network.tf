data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_ec2_instance_type_offerings" "selected" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }

  filter {
    name   = "location"
    values = data.aws_availability_zones.available.names
  }
}

locals {
  supported_availability_zones = sort(tolist(data.aws_ec2_instance_type_offerings.selected.locations))
  selected_availability_zone = var.availability_zone != "" ? var.availability_zone : try(
    local.supported_availability_zones[0],
    ""
  )
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-${var.environment}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.name_prefix}-${var.environment}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = local.selected_availability_zone
  map_public_ip_on_launch = true

  lifecycle {
    precondition {
      condition     = length(local.supported_availability_zones) > 0
      error_message = "The selected EC2 instance type is not offered in any available AZ in ${var.aws_region}."
    }
    precondition {
      condition     = contains(local.supported_availability_zones, local.selected_availability_zone)
      error_message = "availability_zone must be an available AZ that offers ${var.instance_type}; choose one of ${join(", ", local.supported_availability_zones)}."
    }
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-public-subnet" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
