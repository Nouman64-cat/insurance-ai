resource "random_id" "bucket_suffix" {
  byte_length = 4

  keepers = {
    prefix      = var.name_prefix
    environment = var.environment
    region      = var.aws_region
  }
}

resource "aws_s3_bucket" "app" {
  count = var.create_app_s3_bucket ? 1 : 0

  bucket        = "${var.name_prefix}-${var.environment}-${random_id.bucket_suffix.hex}"
  force_destroy = false

  tags = { Name = "${var.name_prefix}-${var.environment}-app-data" }
}

resource "aws_s3_bucket_public_access_block" "app" {
  count = var.create_app_s3_bucket ? 1 : 0

  bucket                  = aws_s3_bucket.app[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "app" {
  count = var.create_app_s3_bucket ? 1 : 0

  bucket = aws_s3_bucket.app[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "app" {
  count = var.create_app_s3_bucket ? 1 : 0

  bucket = aws_s3_bucket.app[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app" {
  count = var.create_app_s3_bucket ? 1 : 0

  bucket = aws_s3_bucket.app[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = false
  }
}

data "aws_iam_policy_document" "app_bucket_tls" {
  count = var.create_app_s3_bucket ? 1 : 0

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    resources = [
      aws_s3_bucket.app[0].arn,
      "${aws_s3_bucket.app[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "app_tls" {
  count = var.create_app_s3_bucket ? 1 : 0

  bucket = aws_s3_bucket.app[0].id
  policy = data.aws_iam_policy_document.app_bucket_tls[0].json

  depends_on = [aws_s3_bucket_public_access_block.app]
}
