#!/bin/bash
set -e

cd /docker/banking-api-lab

echo "Pulling latest code..."
git pull origin main

echo "Building and restarting containers..."
docker compose -f docker-compose.prod.yml up -d --build

echo "Deploy complete!"
