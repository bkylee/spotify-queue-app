#!/bin/bash
set -e
echo "📦 Zipping app..."
zip -r deploy.zip . --exclude "node_modules/*" --exclude "terraform/*" --exclude ".git/*" --exclude "*.zip"

echo "🚀 Deploying to Azure..."
az webapp deploy \
  --name spotify-queue-neon-fox \
  --resource-group learn-7d094fbd-dd2b-4679-a3a1-20f48cfb12a2 \
  --src-path deploy.zip \
  --type zip

rm deploy.zip
echo "✅ Done! https://spotify-queue-neon-fox.azurewebsites.net"