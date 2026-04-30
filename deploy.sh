#!/usr/bin/env bash
set -euo pipefail
aws s3 cp s3://mullmania.com-data/_tools/deploy.sh - | bash -s -- apply
