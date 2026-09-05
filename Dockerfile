FROM node:22-alpine

WORKDIR /app

# Dépendances de production
COPY package*.json ./
RUN npm ci --omit=dev

# Code source
COPY . .

# Création des dossiers nécessaires et permissions pour UID 1000 (standard Hugging Face & sécurité)
RUN mkdir -p data/backups && chown -R 1000:1000 /app

USER 1000

ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
