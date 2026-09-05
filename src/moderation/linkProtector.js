import { config } from '../config.js';

export class LinkProtector {
  // Regex pour les liens d'invitation Telegram externes et canaux tiers
  static INVITE_LINK_REGEX = /(?:t\.me|telegram\.me|telegram\.dog)\/(?:\+|joinchat\/|[a-zA-Z0-9_]{5,})/i;

  // Regex pour les réducteurs de liens et arnaques fréquentes
  static SUSPICIOUS_SHORTENER_REGEX = /(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|is\.gd|buff\.ly|adf\.ly|cutt\.ly|shorturl\.at|ow\.ly)/i;

  // Regex pour les arnaques cryptos / adult leaks fréquentes
  static SCAM_PATTERNS = /(?:onlyfans\.com\/|fansly\.com\/|wa\.me\/|t\.me\/proxy|gratuit\.xyz|free-crypto|airdrop)/i;

  /**
   * Analyse le texte pour détecter des liens d'invitation ou des spams interdits
   * @param {string} text 
   * @param {string} currentBotUsername
   * @returns {{ isBlocked: boolean, reason: string }}
   */
  static checkLinks(text, currentBotUsername = '') {
    if (!config.antiLinksEnabled || !text) {
      return { isBlocked: false, reason: '' };
    }

    // Autoriser les mentions normales du bot lui-même (ex: t.me/Lenasituation_bot)
    if (currentBotUsername && text.includes(`t.me/${currentBotUsername}`)) {
      return { isBlocked: false, reason: '' };
    }

    // 1. Détection de liens d'invitation Telegram vers d'autres canaux/groupes
    if (this.INVITE_LINK_REGEX.test(text)) {
      // Ignorer si c'est le bot lui-même
      if (!currentBotUsername || !new RegExp(`t\\.me\\/${currentBotUsername}`, 'i').test(text)) {
        return {
          isBlocked: true,
          reason: "Lien d'invitation ou promotion externe non autorisée"
        };
      }
    }

    // 2. Détection de raccourcisseurs d'URL suspects
    if (this.SUSPICIOUS_SHORTENER_REGEX.test(text)) {
      return {
        isBlocked: true,
        reason: "Lien raccourci suspect ou redirection potentiellement frauduleuse"
      };
    }

    // 3. Détection de liens d'arnaques ou pornographiques
    if (this.SCAM_PATTERNS.test(text)) {
      return {
        isBlocked: true,
        reason: "Lien publicitaire ou contenu suspect interdit"
      };
    }

    return { isBlocked: false, reason: '' };
  }
}
