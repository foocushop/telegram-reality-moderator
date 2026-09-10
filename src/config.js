import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Telegram Bot Token (obtenu gratuitement via @BotFather sur Telegram)
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // Clé API Google Gemini (gratuite sur https://aistudio.google.com/)
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  // Clé API alternative gratuite Groq (si Google Cloud bloque votre région/compte : https://console.groq.com)
  groqApiKey: process.env.GROQ_API_KEY || '',

  // Moteur d'IA choisi : 'groq' ou 'gemini' (par défaut : si une clé Groq est présente, utilise Groq)
  aiProvider: (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? 'groq' : 'gemini')).toLowerCase(),

  // Modèles Groq recommandés et vérifiés (quotas séparés de 200k TPD chacun)
  groqTextModel: process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b',
  groqVisionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',

  // Modèle Gemini utilisé (gemini-3.6-flash est le modèle recommandé le plus récent et gratuit)
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',

  // Durée de mise en sourdine (mute) pour insultes légères en minutes (par défaut 15 min)
  muteDurationMinutes: parseInt(process.env.MUTE_DURATION_MINUTES || '15', 10),

  // Supprimer automatiquement les messages qui enfreignent les règles
  deleteOffendingMessages: process.env.DELETE_OFFENDING_MESSAGES !== 'false',

  // Notifier dans le chat lorsqu'un membre est banni ou muté
  notifyChatOnAction: process.env.NOTIFY_CHAT_ON_ACTION !== 'false',

  // ID du canal d'audit dédié pour la surveillance des conversations privées des membres
  auditChannelId: process.env.AUDIT_CHANNEL_ID ? String(process.env.AUDIT_CHANNEL_ID).trim() : null,

  // ID Telegram des administrateurs (séparés par des virgules), immunisés contre la modération
  adminUserIds: (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id)),

  // Contexte et personnalité du bot pour ses réponses intelligentes
  botPersonalityContext: process.env.BOT_PERSONALITY_CONTEXT || 
    "Tu es Léna (Léna Situations, @Lenasituation_bot), l'animatrice officielle et modératrice complice du groupe Télé-Réalité. " +
    "Tu as une personnalité solaire, bienveillante, dynamique et pleine d'énergie positive (+ = +). " +
    "Tu suis à fond Secret Story, Les Cinquante, Koh-Lanta, Les Anges, etc. Tu t'exprimes avec naturel, décontraction et des touches discrètes de l'univers de Léna Situations ('+ = +', 'en vrai', 'trop zinzin', etc.), sans jamais en abuser. " +
    "Tes réponses sont courtes (1 à 2 phrases max), amicales et percutantes.",

  // Probabilité d'intervention spontanée du bot sur un message normal (0 = jamais, 0.05 = 5%)
  spontaneousReplyRate: parseFloat(process.env.SPONTANEOUS_REPLY_RATE || '0'),

  // Protection Anti-Flood (limitation d'envoi rapide de messages)
  antiFloodEnabled: process.env.ANTI_FLOOD_ENABLED !== 'false',
  floodMaxMessages: parseInt(process.env.FLOOD_MAX_MESSAGES || '5', 10),
  floodWindowSeconds: parseInt(process.env.FLOOD_WINDOW_SECONDS || '4', 10),

  // Protection Anti-Pub et Liens suspects (invitations Telegram tierces, scams)
  antiLinksEnabled: process.env.ANTI_LINKS_ENABLED !== 'false',

  // Seuil d'avertissements avant bannissement définitif (par défaut 3 avertissements)
  maxWarningsBeforeBan: parseInt(process.env.MAX_WARNINGS_BEFORE_BAN || '3', 10),

  // Souhaiter la bienvenue aux nouveaux membres
  welcomeNewMembers: process.env.WELCOME_NEW_MEMBERS === 'true',

  // Mode simulation / test sans clés réelles
  mockMode: process.env.MOCK_MODE === 'true'
};

import fs from 'fs';
import path from 'path';

/**
 * Récupère le contexte du bot : soit depuis le fichier context.txt, soit depuis .env
 */
export function getBotContext() {
  try {
    const contextPath = path.resolve('context.txt');
    if (fs.existsSync(contextPath)) {
      const content = fs.readFileSync(contextPath, 'utf-8').trim();
      if (content) return content;
    }
  } catch (err) {
    console.error('[CONFIG] Erreur de lecture de context.txt:', err.message);
  }
  return config.botPersonalityContext;
}
