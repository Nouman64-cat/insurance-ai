#!/bin/bash
set -Eeuo pipefail

exec > >(tee -a /var/log/insurance-ai-bootstrap.log | logger -t insurance-ai-bootstrap -s 2>/dev/console) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl git jq docker.io docker-compose-v2
systemctl enable --now docker

# Ubuntu cloud images may ship the agent as a snap or a deb. Preserve an existing install,
# and install the snap only if neither service is already available.
if systemctl list-unit-files amazon-ssm-agent.service --no-legend 2>/dev/null | grep -q amazon-ssm-agent; then
  systemctl enable --now amazon-ssm-agent
else
  if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
    snap install amazon-ssm-agent --classic
  fi
  systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
fi

install -d -m 0750 -o ubuntu -g ubuntu /srv/insurance-ai
usermod -aG docker ubuntu

cat > /etc/motd <<'MOTD'
Insurance AI deployment host
- Connect with AWS Systems Manager Session Manager (no SSH port is open).
- Application deployment prerequisites are documented in infrastructure/terraform/README.md.
MOTD

touch /var/lib/insurance-ai-bootstrap-complete
