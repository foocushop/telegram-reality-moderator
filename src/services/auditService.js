import { db } from '../storage/database.js';
import { escapeHtml } from '../utils/format.js';

/**
 * Nettoie les balises HTML d'une chaîne pour éviter les conflits d'imbrication HTML dans Telegram
 */
export function stripHtml(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim();
}

export class AuditService {
  /**
   * Enregistre et audite une interaction privée entre un utilisateur et le bot
   * 1. Affiche un bloc clair et formaté dans les logs Render
   * 2. Transmet une copie en direct au canal Telegram d'audit si configuré
   *
   * @param {import('grammy').Context} ctx - Le contexte Grammy du message
   * @param {string} userMessage - Le message envoyé par l'utilisateur
   * @param {string} botReply - La réponse générée par le bot
   * @param {Object} [options] - Options facultatives (ex: tag personnalisé)
   */
  static async logPrivateInteraction(ctx, userMessage, botReply, options = {}) {
    const user = ctx?.from;
    const userId = user?.id || 'Inconnu';
    const username = user?.username ? `@${user.username}` : null;
    const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Utilisateur';
    const userDisplay = username ? `${username} (${fullName})` : fullName;

    const cleanUserMsg = String(userMessage || '').trim();
    const cleanBotReply = String(botReply || '').trim();
    const tag = options.tag || 'MEMBRE';

    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const timestampStr = `${dateStr} à ${timeStr}`;

    // 1. LOG RENDER CONSOLE (Visible instantanément sur Render)
    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log(`📩 [AUDIT CHAT PRIVÉ - ${tag}] NOUVEAU MESSAGE REÇU`);
    console.log(`👤 De           : ${userDisplay} [ID: ${userId}]`);
    console.log(`🕒 Horodatage   : ${timestampStr}`);
    console.log(`💬 Message reçu : "${cleanUserMsg.slice(0, 500)}${cleanUserMsg.length > 500 ? '...' : ''}"`);
    console.log('───────────────────────────────────────────────────────────────────');
    console.log(`🤖 [AUDIT CHAT PRIVÉ - ${tag}] RÉPONSE DE LÉNA`);
    console.log(`📤 À           : ${userDisplay} [ID: ${userId}]`);
    console.log(`💬 Réponse bot : "${stripHtml(cleanBotReply).slice(0, 500)}${cleanBotReply.length > 500 ? '...' : ''}"`);
    console.log('═══════════════════════════════════════════════════════════════════\n');

    // 2. TRANSMISSION EN DIRECT AU CANAL TELEGRAM D'AUDIT DÉDIÉ
    const auditChannelId = db.getEffectiveAuditChannelId();
    if (!auditChannelId || !ctx?.api) {
      return;
    }

    try {
      const userTagForTelegram = username
        ? `<b>${escapeHtml(fullName)}</b> (${escapeHtml(username)} | <code>${userId}</code>)`
        : `<b>${escapeHtml(fullName)}</b> (<code>${userId}</code>)`;

      // Préparation du contenu textuel avec protection anti-balises brisées
      const displayUserText = escapeHtml(cleanUserMsg || '(Message vide ou média)');
      const displayBotText = escapeHtml(stripHtml(cleanBotReply) || '(Aucun texte retourné)');

      const telegramAuditMsg =
        `🕵️ <b>[AUDIT CHAT PRIVÉ]</b>\n\n` +
        `👤 <b>Membre :</b> ${userTagForTelegram}\n` +
        `🕒 <b>Date :</b> ${timestampStr}\n\n` +
        `📥 <b>Message reçu :</b>\n` +
        `<i>"${displayUserText}"</i>\n\n` +
        `🤖 <b>Réponse de Léna :</b>\n` +
        `<i>"${displayBotText}"</i>`;

      await ctx.api.sendMessage(auditChannelId, telegramAuditMsg, {
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error(`[AUDIT SERVICE] ⚠️ Impossible d'envoyer la copie au canal d'audit (${auditChannelId}) :`, err.message);
      console.error(`👉 Vérifiez que le bot a bien été ajouté comme administrateur avec droit de publication dans le canal d'audit.`);
    }
  }

  /**
   * Envoie un message de test dans le canal d'audit pour vérifier la configuration
   */
  static async sendTestMessage(api, channelId) {
    if (!api || !channelId) {
      throw new Error('API ou ID de canal manquant.');
    }

    const testMsg =
      `🧪 <b>[TEST CANAL D'AUDIT PRIVÉ]</b>\n\n` +
      `✅ <b>Connexion réussie !</b>\n` +
      `Ce canal est désormais configuré comme le canal d'audit officiel de Léna.\n\n` +
      `Toutes les conversations privées des membres avec le bot (messages reçus et réponses apportées) seront automatiquement consignées ici en temps réel.\n\n` +
      `🕒 <i>Vérifié le ${new Date().toLocaleString('fr-FR')}</i>`;

    return await api.sendMessage(channelId, testMsg, { parse_mode: 'HTML' });
  }
}
