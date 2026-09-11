import { InputFile } from 'grammy';
import { db } from '../storage/database.js';

/**
 * Service de Persistance et Synchronisation Cloud (Telegram Cloud Engine)
 * Permet au bot de stocker son état complet (utilisateurs, séries, configurations)
 * directement sur Telegram et de le restaurer instantanément au démarrage sur Render.
 */
export class CloudSyncService {
  static debounceTimer = null;
  static lastCloudSyncAt = null;

  /**
   * Récupère l'identifiant du canal ou chat de stockage
   */
  static getStorageChatId() {
    return db.getStorageChatId();
  }

  /**
   * Sauvegarde immédiatement l'état complet du bot sur Telegram Cloud
   * @param {Object} api - Instance api de Grammy (ctx.api ou bot.api)
   * @param {string} reason - Motif de la sauvegarde ('boot', 'manual', 'update', 'auto')
   */
  static async saveToCloud(api, reason = 'auto') {
    const chatId = this.getStorageChatId();
    if (!chatId) {
      return { success: false, reason: 'no_storage_chat_configured' };
    }

    if (!api || typeof api.sendDocument !== 'function') {
      return { success: false, reason: 'invalid_api_instance' };
    }

    try {
      const fullState = db.getFullState();
      const meta = {
        reason,
        savedAt: new Date().toISOString(),
        knownUsersCount: Object.keys(db.data.knownUsers || {}).length,
        privateUsersCount: Object.keys(db.data.privateUsers || {}).length,
        showsCount: Object.keys(db.data.shows || {}).length,
        mastersCount: (db.data.masters || []).length
      };

      const payload = {
        ...fullState,
        meta
      };

      const jsonString = JSON.stringify(payload, null, 2);
      const buffer = Buffer.from(jsonString, 'utf-8');

      const dateStr = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
      const caption =
        `📦 <b>#CLOUD_STATE_BACKUP [Auto-Sync]</b>\n\n` +
        `🕒 <b>Date :</b> <code>${dateStr}</code>\n` +
        `👤 <b>Membres enregistrés :</b> <b>${meta.privateUsersCount}</b> privés (<b>${meta.knownUsersCount}</b> connus)\n` +
        `🎬 <b>Émissions :</b> <b>${meta.showsCount}</b> séries répertoriées\n` +
        `👑 <b>Maîtres :</b> <b>${meta.mastersCount}</b> configurés\n` +
        `🏷️ <b>Motif :</b> <code>${reason}</code>\n\n` +
        `🛡️ <i>Sauvegarde d'état cloud persistante. Restaurée automatiquement à chaque démarrage sur Render.</i>`;

      const docMsg = await api.sendDocument(
        chatId,
        new InputFile(buffer, 'reality_bot_cloud_backup.json'),
        {
          caption,
          parse_mode: 'HTML'
        }
      );

      // Épingler le document pour qu'au prochain boot, le bot le trouve immédiatement
      try {
        if (typeof api.pinChatMessage === 'function') {
          await api.pinChatMessage(chatId, docMsg.message_id, { disable_notification: true });
        }
      } catch (pinErr) {
        console.warn('[CLOUD SYNC] ⚠️ Message envoyé mais impossible de l\'épingler :', pinErr.message);
      }

      this.lastCloudSyncAt = new Date().toISOString();
      console.log(`[CLOUD SYNC] ☁️ Sauvegarde Cloud réussie dans ${chatId} (${meta.privateUsersCount} membres privés, ${meta.showsCount} séries).`);
      return { success: true, messageId: docMsg.message_id, meta };
    } catch (err) {
      console.error('[CLOUD SYNC] ❌ Erreur lors de la sauvegarde Cloud Telegram :', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Planifie une sauvegarde temporisée (Debounced) pour éviter les spams de requêtes
   */
  static triggerDebouncedSave(api, delayMs = 20000, reason = 'auto') {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.saveToCloud(api, reason);
    }, delayMs);
  }

  /**
   * Restaure l'état du bot depuis le dernier instantané épinglé dans Telegram Cloud
   * @param {Object} api - Instance api de Grammy (bot.api)
   */
  static async hydrateFromCloud(api) {
    const chatId = this.getStorageChatId();
    if (!chatId) {
      console.log('[CLOUD SYNC] ℹ️ Aucun canal/chat de stockage persistant configuré.');
      return { success: false, reason: 'no_storage_chat_configured' };
    }

    if (!api || typeof api.getChat !== 'function') {
      return { success: false, reason: 'invalid_api_instance' };
    }

    console.log(`[CLOUD SYNC] 🔍 Recherche du dernier instantané Cloud dans le chat ${chatId}...`);

    try {
      const chat = await api.getChat(chatId);
      const pinnedMsg = chat.pinned_message;

      if (!pinnedMsg || !pinnedMsg.document) {
        console.log('[CLOUD SYNC] ℹ️ Aucun document épinglé trouvé dans le chat de stockage.');
        return { success: false, reason: 'no_pinned_document' };
      }

      const doc = pinnedMsg.document;
      const isBackupDoc =
        (doc.file_name && doc.file_name.toLowerCase().endsWith('.json')) ||
        (pinnedMsg.caption && pinnedMsg.caption.includes('#CLOUD_STATE_BACKUP'));

      if (!isBackupDoc) {
        console.log(`[CLOUD SYNC] ℹ️ Le document épinglé (${doc.file_name}) n'est pas un fichier d'état du bot.`);
        return { success: false, reason: 'unrecognized_document' };
      }

      const fileInfo = await api.getFile(doc.file_id);
      if (!fileInfo || !fileInfo.file_path) {
        return { success: false, reason: 'file_path_unavailable' };
      }

      const token = api.token || process.env.TELEGRAM_BOT_TOKEN;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

      const res = await fetch(fileUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} lors du téléchargement de l'instantané`);
      }

      const rawText = await res.text();
      const state = JSON.parse(rawText);

      const restored = db.restoreFullState(state);
      if (restored) {
        const usersCount = Object.keys(db.data.knownUsers || {}).length;
        const privUsersCount = Object.keys(db.data.privateUsers || {}).length;
        const showsCount = Object.keys(db.data.shows || {}).length;
        console.log(`[CLOUD SYNC] 🚀 RESTAURATION CLOUD RÉUSSIE !`);
        console.log(`[CLOUD SYNC] 📊 Données restaurées : ${privUsersCount} membres privés, ${usersCount} membres connus, ${showsCount} séries.`);
        return {
          success: true,
          restoredAt: new Date().toISOString(),
          usersCount: privUsersCount,
          showsCount
        };
      } else {
        return { success: false, reason: 'restore_failed_or_empty' };
      }
    } catch (err) {
      console.error('[CLOUD SYNC] ❌ Impossible de restaurer depuis Telegram Cloud :', err.message);
      return { success: false, error: err.message };
    }
  }
}
