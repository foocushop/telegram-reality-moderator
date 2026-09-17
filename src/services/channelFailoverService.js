import { db } from '../storage/database.js';
import { escapeHtml } from '../utils/format.js';
import { CloudSyncService } from './cloudSyncService.js';

/**
 * Service de surveillance silencieuse (Health Check) et de bascule automatique
 * vers des canaux de réserve (Standby Failover) avec diffusion immédiate aux membres.
 */
export class ChannelFailoverService {
  /**
   * Vérifie furtivement si un canal Telegram est vivant sans RIEN poster dessus (100% silencieux)
   *
   * @param {import('grammy').Api} api - Instance de l'API Grammy
   * @param {string|number} channelId - Identifiant Telegram du canal
   * @returns {Promise<{alive: boolean, error?: string, chat?: object, details?: string}>}
   */
  static async checkChannelHealth(api, channelId) {
    if (!api || !channelId) {
      return { alive: false, error: 'missing_params', details: 'API ou Channel ID manquant' };
    }

    try {
      // 1. Récupération invisible des métadonnées du chat (getChat)
      const chat = await api.getChat(channelId);
      return {
        alive: true,
        chat: {
          id: chat.id,
          title: chat.title || 'Canal sans nom',
          type: chat.type,
          username: chat.username || null
        }
      };
    } catch (err) {
      const errMsg = String(err.message || '').toLowerCase();
      let errorCategory = 'channel_unreachable';

      if (errMsg.includes('chat not found') || errMsg.includes('not found')) {
        errorCategory = 'chat_not_found';
      } else if (errMsg.includes('kicked') || errMsg.includes('not a member') || errMsg.includes('forbidden')) {
        errorCategory = 'bot_kicked';
      } else if (errMsg.includes('deactivated') || errMsg.includes('migrated')) {
        errorCategory = 'channel_deactivated';
      }

      return {
        alive: false,
        error: errorCategory,
        details: err.message
      };
    }
  }

  /**
   * Déclenche le failover vers le canal de secours suivant pour une émission donnée
   *
   * @param {import('grammy').Api} api - Instance de l'API Grammy
   * @param {string} showNameOrId - Nom ou identifiant de l'émission
   * @param {string} [reason='auto_detected'] - Raison du déclenchement
   * @returns {Promise<{success: boolean, reason?: string, show?: object, standbyChannelId?: string, newLink?: string, notifiedCount?: number}>}
   */
  static async executeFailover(api, showNameOrId, reason = 'auto_detected') {
    const show = db.findShow(showNameOrId);
    if (!show) {
      return { success: false, reason: `Émission "${showNameOrId}" introuvable dans le catalogue.` };
    }

    if (!Array.isArray(show.standbyChannels) || show.standbyChannels.length === 0) {
      // Alerte administrateur : aucun canal de secours disponible !
      await this.notifyAdmins(
        api,
        `🚨 <b>ALERTE CRITIQUE : CANAL MORT MAIS AUCUNE RÉSERVE DISPONIBLE !</b>\n\n` +
        `📺 <b>Émission :</b> ${escapeHtml(show.name)}\n` +
        `❌ <b>Canal actuel :</b> <code>${show.channelId || 'Inconnu'}</code>\n` +
        `⚠️ Le canal ne répond plus mais votre réserve est <b>VIDE</b>.\n\n` +
        `💡 <i>Créez un canal et ajoutez-le avec <code>/addstandby ${escapeHtml(show.name)} | [ID Canal]</code></i>`
      );
      return { success: false, reason: 'no_standby_channels', show };
    }

    const previousChannelId = show.channelId;
    const standbyChannelId = db.popNextStandbyChannel(show.id);

    console.log(`[FAILOVER] 🔄 Bascule de "${show.name}" vers le canal de réserve ${standbyChannelId}...`);

    // 1. Renommer le canal avec le nom officiel de l'émission
    try {
      await api.setChatTitle(standbyChannelId, show.name);
    } catch (err) {
      console.warn(`[FAILOVER] ⚠️ Impossible de renommer le canal ${standbyChannelId} :`, err.message);
    }

    // 2. Mettre à jour la description officielle
    try {
      const desc = show.description || `Canal officiel pour ${show.name}. Liens et épisodes exclusifs.`;
      await api.setChatDescription(standbyChannelId, desc);
    } catch (err) {
      console.warn(`[FAILOVER] ⚠️ Impossible de modifier la description du canal ${standbyChannelId} :`, err.message);
    }

    // 3. Appliquer la photo de profil par défaut si disponible
    if (show.photo) {
      try {
        await api.setChatPhoto(standbyChannelId, show.photo);
      } catch (err) {
        console.warn(`[FAILOVER] ⚠️ Impossible d'appliquer la photo sur le canal ${standbyChannelId} :`, err.message);
      }
    }

    // 4. Générer ou extraire le lien d'invitation officiel
    let newLink = null;
    try {
      const invite = await api.createChatInviteLink(standbyChannelId, {
        name: `${show.name} - Officiel`
      });
      if (invite && invite.invite_link) {
        newLink = invite.invite_link;
      }
    } catch (err) {
      console.warn(`[FAILOVER] ⚠️ createChatInviteLink a échoué (${err.message}), tentative export...`);
    }

    if (!newLink) {
      try {
        newLink = await api.exportChatInviteLink(standbyChannelId);
      } catch (err) {
        console.warn(`[FAILOVER] ⚠️ exportChatInviteLink a échoué :`, err.message);
        newLink = `https://t.me/c/${String(standbyChannelId).replace('-100', '')}`;
      }
    }

    // 5. Mettre à jour le catalogue de séries dans la base
    const updatedShow = db.setShowChannel(show.id, standbyChannelId, newLink);

    // 6. Sauvegarde Cloud immédiate et épinglage
    await CloudSyncService.saveToCloud(api, `failover_${show.id}`);

    // 7. Diffusion automatique (Broadcast) à tous les utilisateurs avec photo et lien
    const broadcastResult = await this.broadcastNewChannelToUsers(api, updatedShow, newLink);

    // 8. Notification de succès au Propriétaire et aux Maîtres
    const remainingStandby = (updatedShow.standbyChannels || []).length;
    await this.notifyAdmins(
      api,
      `🛡️ <b>FAILOVER RÉUSSI : NOUVEAU CANAL ACTIVÉ !</b> 🚀\n\n` +
      `📺 <b>Émission :</b> <b>${escapeHtml(show.name)}</b>\n` +
      `❌ <b>Ancien canal défaillant :</b> <code>${previousChannelId || 'Non défini'}</code>\n` +
      `✅ <b>Nouveau canal de réserve activé :</b> <code>${standbyChannelId}</code>\n` +
      `🔗 <b>Nouveau lien officiel :</b> <code>${newLink}</code>\n` +
      `📢 <b>Membres prévenus en MP :</b> <b>${broadcastResult.successCount}</b>\n` +
      `📦 <b>Canaux de réserve restants :</b> <b>${remainingStandby}</b> canal/aux\n\n` +
      `☁️ <i>Le catalogue /shows et la sauvegarde Cloud ont été automatiquement mis à jour.</i>`
    );

    return {
      success: true,
      show: updatedShow,
      standbyChannelId,
      newLink,
      notifiedCount: broadcastResult.successCount,
      remainingStandby
    };
  }

  /**
   * Diffuse le message avec la photo de la série et le nouveau lien à tous les utilisateurs enregistrés
   * @private
   */
  static async broadcastNewChannelToUsers(api, show, newLink) {
    if (!api) return { successCount: 0, failureCount: 0 };

    const users = db.getPrivateUsers(true);
    let successCount = 0;
    let failureCount = 0;

    const messageText =
      `📺 <b>Nouveaux canaux créés pour ${escapeHtml(show.name)}</b> 👉 ${newLink}\n\n` +
      `L'ancien canal a sauté ou a été suspendu suite à un signalement.\n` +
      `Rejoignez dès maintenant le nouveau canal officiel ci-dessus pour continuer à suivre les épisodes ! 🍿🌴✨\n\n` +
      `<i>— L'équipe & Léna (+ = +)</i>`;

    for (const u of users) {
      try {
        if (show.photo) {
          // Envoi de la photo officielle avec la légende
          await api.sendPhoto(u.userId, show.photo, {
            caption: messageText,
            parse_mode: 'HTML'
          });
        } else {
          // Envoi sous forme de message textuel propre
          await api.sendMessage(u.userId, messageText, {
            parse_mode: 'HTML'
          });
        }
        successCount++;
      } catch (err) {
        failureCount++;
        const errMsg = String(err.message || '');
        if (errMsg.includes('bot was blocked') || errMsg.includes('user is deactivated')) {
          db.markPrivateUserReachable(u.userId, false, errMsg);
        }
      }

      // Petite pause pour respecter les quotas Telegram (max 30 msgs/s)
      if (users.length > 20) {
        await new Promise(r => setTimeout(r, 40));
      }
    }

    return { successCount, failureCount };
  }

  /**
   * Scanne silencieusement toutes les émissions ayant un canal associé et bascule si nécessaire
   *
   * @param {import('grammy').Api} api - Instance de l'API Grammy
   * @returns {Promise<{checkedCount: number, deadCount: number, failovers: Array}>}
   */
  static async checkAllMonitoredShows(api) {
    if (!api) return { checkedCount: 0, deadCount: 0, failovers: [] };

    const monitoredShows = db.getShowsWithMonitoring();
    let checkedCount = 0;
    let deadCount = 0;
    const failovers = [];

    for (const show of monitoredShows) {
      if (!show.channelId) continue;
      checkedCount++;

      const health = await this.checkChannelHealth(api, show.channelId);
      if (!health.alive) {
        deadCount++;
        console.warn(`[WATCHDOG] 🚨 Canal mort détecté pour "${show.name}" (${show.channelId}) : ${health.error} (${health.details})`);

        // Si des canaux de secours sont disponibles, déclencher le failover
        if (Array.isArray(show.standbyChannels) && show.standbyChannels.length > 0) {
          const failoverResult = await this.executeFailover(api, show.id, health.error);
          failovers.push({
            showName: show.name,
            oldChannelId: show.channelId,
            failoverResult
          });
        } else {
          // Pas de canaux de secours : avertir les administrateurs
          await this.notifyAdmins(
            api,
            `⚠️ <b>CANAL INACCESSIBLE DÉTECTÉ POUR "${escapeHtml(show.name)}"</b>\n\n` +
            `• <b>Canal :</b> <code>${show.channelId}</code>\n` +
            `• <b>Erreur :</b> <code>${health.error}</code> (${escapeHtml(health.details || '')})\n` +
            `• <b>État réserve :</b> <i>Aucun canal de secours configuré !</i>\n\n` +
            `💡 <i>Tapez <code>/addstandby ${escapeHtml(show.name)} | [ID Canal]</code> pour ajouter une réserve.</i>`
          );
        }
      }
    }

    return { checkedCount, deadCount, failovers };
  }

  /**
   * Alerte le propriétaire et les maîtres en message privé
   * @private
   */
  static async notifyAdmins(api, text) {
    if (!api || !text) return;
    const adminIds = new Set();

    const ownerId = db.getOwnerId();
    if (ownerId) adminIds.add(ownerId);

    const masters = db.getMasters();
    masters.forEach(m => m.id && adminIds.add(m.id));

    for (const adminId of adminIds) {
      try {
        await api.sendMessage(adminId, text, { parse_mode: 'HTML' });
      } catch (e) {
        // Ignorer si l'admin n'a pas ouvert le chat
      }
    }
  }
}
