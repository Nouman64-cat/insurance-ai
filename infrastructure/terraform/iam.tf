data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name_prefix}-${var.environment}-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
  description        = "SSM access and scoped application S3 permissions for the Insurance AI host."
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name_prefix}-${var.environment}-ec2"
  role = aws_iam_role.instance.name
}

resource "aws_iam_role_policy" "app_s3" {
  count = var.create_app_s3_bucket ? 1 : 0
  name  = "${var.name_prefix}-${var.environment}-app-s3"
  role  = aws_iam_role.instance.id

  policy = data.aws_iam_policy_document.app_s3[0].json
}

data "aws_iam_policy_document" "app_s3" {
  count = var.create_app_s3_bucket ? 1 : 0

  statement {
    sid       = "ListApplicationBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.app[0].arn]
  }

  statement {
    sid    = "ManageApplicationObjects"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.app[0].arn}/*"]
  }
}
