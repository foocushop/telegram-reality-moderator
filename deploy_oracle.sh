#!/bin/bash
set -e

echo "🚀 [1/4] Mise à jour du système Ubuntu..."
sudo apt update && sudo apt upgrade -y

echo "📦 [2/4] Installation de Node.js 22 LTS & Git..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

echo "⚡ [3/4] Installation de PM2 (Gestionnaire 24h/24)..."
sudo npm install -g pm2

echo "📥 [4/4] Installation des dépendances npm..."
npm install

echo ""
echo "=================================================="
echo "✅ Système prêt pour le bot Léna Modératrice !"
echo "👉 1. Configurez votre fichier .env : nano .env"
echo "👉 2. Démarrez le bot 24h/24 : pm2 start ecosystem.config.cjs"
echo "👉 3. Activez le redémarrage au boot : pm2 startup && pm2 save"
echo "=================================================="
