import { db } from '../storage/database.js';
import { config } from '../config.js';

/**
 * Résout la cible (ID et détails) pour les commandes /ban, /mute, /unban, /unmute
 * Supporte :
 *  - La réponse directe à un message
 *  - La mention @username (ou sans @)
 *  - La mention native Telegram (text_mention)
 *  - L'ID numérique
 * 
 * @param {import('grammy').Context} ctx 
 * @param {'ban' | 'mute' | 'unban' | 'unmute'} commandType 
 */
export function resolveTarget(ctx, commandType) {
  const message = ctx.message;
  if (!message) {
    return { error: "Message introuvable." };
  }

  const replyMsg = message.reply_to_message;
  const fullText = (message.text || '').trim();
  const parts = fullText.split(/\s+/);

  let targetUserId = null;
  let targetDetails = { username: '', fullName: '' };
  let minutes = config.muteDurationMinutes;
  let reason = '';

  // CAS 1 : En réponse à un message
  if (replyMsg && replyMsg.from) {
    targetUserId = replyMsg.from.id;
    targetDetails = {
      username: replyMsg.from.username || '',
      fullName: [replyMsg.from.first_name, replyMsg.from.last_name].filter(Boolean).join(' ')
    };
    db.saveUser(targetUserId, targetDetails);

    // Extraction des paramètres optionnels après la commande
    // Exemples :
    // /ban insultes graves
    // /mute 30
    // /mute 30 propos déplacés
    const args = parts.slice(1);
    if (commandType === 'mute') {
      if (args[0] && !isNaN(args[0])) {
        minutes = parseInt(args[0], 10);
        reason = args.slice(1).join(' ');
      } else {
        reason = args.join(' ');
      }
    } else {
      reason = args.join(' ');
    }

    let defaultReason = 'Action manuelle par administrateur';
    if (commandType === 'ban') defaultReason = 'Bannissement manuel par administrateur';
    if (commandType === 'mute') defaultReason = 'Mise en sourdine manuelle';
    if (commandType === 'warn') defaultReason = 'Avertissement manuel par administrateur';

    return {
      userId: targetUserId,
      userDetails: targetDetails,
      minutes,
      reason: reason || defaultReason
    };
  }

  // CAS 2 : Par mention Telegram native (text_mention)
  const entities = message.entities || [];
  const textMentionEntity = entities.find(e => e.type === 'text_mention');
  if (textMentionEntity && textMentionEntity.user) {
    targetUserId = textMentionEntity.user.id;
    targetDetails = {
      username: textMentionEntity.user.username || '',
      fullName: [textMentionEntity.user.first_name, textMentionEntity.user.last_name].filter(Boolean).join(' ')
    };
    db.saveUser(targetUserId, targetDetails);
  }

  // CAS 3 : Par argument écrit (@username ou ID)
  if (!targetUserId && parts[1]) {
    const candidate = parts[1];

    // Si c'est un ID numérique
    if (/^\d+$/.test(candidate)) {
      targetUserId = Number(candidate);
      const known = db.getUserDetails(targetUserId);
      if (known) {
        targetDetails = { username: known.username, fullName: known.fullName };
      }
    } else {
      // C'est un pseudo (@username ou username)
      const foundId = db.getUserIdByUsername(candidate);
      if (foundId) {
        targetUserId = foundId;
        const known = db.getUserDetails(foundId);
        targetDetails = {
          username: known?.username || candidate.replace(/^@/, ''),
          fullName: known?.fullName || ''
        };
      } else {
        return {
          error: `⚠️ L'utilisateur <b>${candidate}</b> n'est pas encore connu dans la mémoire du bot.\n\n` +
                 `💡 <b>Astuce facile :</b> Répondez simplement directement au message du fauteur de troubles en écrivant <code>/${commandType}</code> !`
        };
      }
    }
  }

  if (!targetUserId) {
    return {
      error: `⚠️ <b>Utilisation :</b>\n` +
             `• Répondez directement au message avec <code>/${commandType}</code>\n` +
             `• Ou écrivez : <code>/${commandType} @pseudo</code>\n` +
             `• Ou écrivez : <code>/${commandType} <ID_NUMERIQUE></code>`
    };
  }

  // Extraction de la durée ou raison pour cas sans réponse
  // Exemple: /ban @pseudo insulte
  // Exemple: /mute @pseudo 30 insulte
  const remainingArgs = parts.slice(2);
  if (commandType === 'mute') {
    if (remainingArgs[0] && !isNaN(remainingArgs[0])) {
      minutes = parseInt(remainingArgs[0], 10);
      reason = remainingArgs.slice(1).join(' ');
    } else {
      reason = remainingArgs.join(' ');
    }
  } else {
    reason = remainingArgs.join(' ');
  }

  let defaultReason = 'Action manuelle par administrateur';
  if (commandType === 'ban') defaultReason = 'Bannissement manuel par administrateur';
  if (commandType === 'mute') defaultReason = 'Mise en sourdine manuelle';
  if (commandType === 'warn') defaultReason = 'Avertissement manuel par administrateur';

  return {
    userId: targetUserId,
    userDetails: targetDetails,
    minutes,
    reason: reason || defaultReason
  };
}
