import { config } from '../config.js';
import { db } from '../storage/database.js';
import { escapeHtml } from '../utils/format.js';

export class ActionManager {
  // Cache en mémoire des administrateurs par chatId : Map<chatId, { timestamp: number, adminIds: Set<number> }>
  static adminCache = new Map();
  static CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Vérifie si un utilisateur est immunisé (Créateur du groupe, Administrateur Telegram, ou Whitelist)
   * @param {import('grammy').Context} ctx 
   * @param {number} userId 
   * @returns {Promise<boolean>}
   */
  static async isImmune(ctx, userId) {
    if (!userId) return false;

    // 0. Immunité absolue du Maître et du Propriétaire
    if (db.isMaster(userId) || db.getOwnerId() === userId) {
      return true;
    }

    // 1. Whitelist explicite (.env)
    if (config.adminUserIds.includes(userId)) {
      return true;
    }

    // 2. Chat privé : aucune restriction dans un dialogue direct avec le bot
    if (ctx?.chat?.type === 'private') {
      return true;
    }

    const chatId = ctx?.chat?.id;

    // 3. Vérification du cache mémoire par chat
    if (chatId && this.adminCache.has(chatId)) {
      const cached = this.adminCache.get(chatId);
      if (Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        if (cached.adminIds.has(userId)) {
          return true;
        }
      }
    }

    // 4. Détection dynamique via l'API Telegram (Statut creator ou administrator)
    if (ctx && typeof ctx.getChatMember === 'function') {
      try {
        const member = await ctx.getChatMember(userId);
        if (member && ['creator', 'administrator'].includes(member.status)) {
          if (member.status === 'creator') {
            db.setOwnerId(userId);
          }
          db.addAdminId(userId);
          if (chatId) db.setMainGroupId(chatId);
          this.cacheAdmin(chatId, userId);
          return true;
        }
      } catch (err) {
        // Ignorer en cas d'erreur de requête
      }
    }

    return false;
  }

  /**
   * Mémorise un administrateur dans le cache rapide
   */
  static cacheAdmin(chatId, userId) {
    if (!chatId || !userId) return;
    let entry = this.adminCache.get(chatId);
    if (!entry) {
      entry = { timestamp: Date.now(), adminIds: new Set() };
      this.adminCache.set(chatId, entry);
    }
    entry.adminIds.add(userId);
  }

  /**
   * Rafraîchit la liste de tous les administrateurs du groupe
   */
  static async refreshAdmins(ctx) {
    const chatId = ctx?.chat?.id;
    if (!chatId || typeof ctx.getChatAdministrators !== 'function') return new Set();

    try {
      const admins = await ctx.getChatAdministrators();
      const adminIds = new Set(admins.map(a => a.user.id));
      this.adminCache.set(chatId, {
        timestamp: Date.now(),
        adminIds
      });

      const creator = admins.find(a => a.status === 'creator');
      if (creator) {
        db.setOwnerId(creator.user.id);
      }
      admins.forEach(a => db.addAdminId(a.user.id));
      db.setMainGroupId(chatId);

      console.log(`[ACTION] 👑 ${adminIds.size} administrateurs/propriétaire(s) synchronisés pour le groupe ${chatId}.`);
      return adminIds;
    } catch (err) {
      console.warn('[ACTION] Impossible de récupérer la liste des administrateurs:', err.message);
      return new Set();
    }
  }

  /**
   * Applique un bannissement direct et immédiat
   */
  static async executeBan(ctx, userId, userDetails, reason) {
    if (await this.isImmune(ctx, userId)) {
      console.log(`[ACTION] 👑 Action impossible sur un propriétaire/administrateur du groupe : ${userId}`);
      if (ctx?.reply) {
        await ctx.reply("👑 <b>Action impossible</b> : Cet utilisateur est propriétaire ou administrateur du groupe !", { parse_mode: 'HTML' }).catch(() => {});
      }
      return false;
    }

    try {
      // 1. Suppression du message offensant
      if (config.deleteOffendingMessages && ctx?.message) {
        try {
          await ctx.deleteMessage();
        } catch (delErr) {
          console.warn('[ACTION] Impossible de supprimer le message:', delErr.message);
        }
      }

      // 2. Bannissement Telegram
      await ctx.banChatMember(userId);

      // 3. Enregistrement en base de données locale (anti-retour)
      db.addBannedUser(userId, {
        username: userDetails.username || 'Inconnu',
        fullName: userDetails.fullName || '',
        reason,
        chatId: ctx.chat?.id
      });

      console.log(`[ACTION] 🚫 Utilisateur BANNI: ${userDetails.username || userId} | Motif: ${reason}`);

      // 4. Notification publique dans le chat
      if (config.notifyChatOnAction) {
        const rawTarget = userDetails.username ? `@${userDetails.username}` : (userDetails.fullName || `ID:${userId}`);
        const targetName = escapeHtml(rawTarget);
        const safeReason = escapeHtml(reason);
        await ctx.reply(
          `🚫 <b>BANNISSEMENT DÉFINITIF</b>\n\n` +
          `👤 Membre : ${targetName}\n` +
          `⚖️ Motif : ${safeReason}\n\n` +
          `<i>Les contenus adultes, insultes graves et perturbations sont strictement interdits ici.</i>`,
          { parse_mode: 'HTML' }
        );
      }

      return true;
    } catch (err) {
      console.error(`[ACTION] Échec du bannissement pour ${userId}:`, err.message);
      return false;
    }
  }

  /**
   * Applique une mise en sourdine (mute temporaire)
   */
  static async executeMute(ctx, userId, userDetails, reason, durationMinutes = config.muteDurationMinutes) {
    if (await this.isImmune(ctx, userId)) {
      console.log(`[ACTION] 👑 Utilisateur immunisé contre le mute (propriétaire/admin) : ${userId}`);
      return false;
    }

    try {
      // 1. Suppression du message offensant
      if (config.deleteOffendingMessages && ctx?.message) {
        try {
          await ctx.deleteMessage();
        } catch (delErr) {
          console.warn('[ACTION] Impossible de supprimer le message:', delErr.message);
        }
      }

      // 2. Calcul du temps d'expiration (en secondes Unix)
      const untilDate = Math.floor(Date.now() / 1000) + (durationMinutes * 60);

      // 3. Restriction des droits d'écriture sur Telegram
      await ctx.restrictChatMember(userId, {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }, {
        until_date: untilDate
      });

      // 4. Enregistrement en base
      db.addMutedUser(userId, {
        username: userDetails.username || 'Inconnu',
        fullName: userDetails.fullName || '',
        reason,
        chatId: ctx.chat?.id
      }, durationMinutes);

      console.log(`[ACTION] ⏳ Utilisateur MUTÉ (${durationMinutes}m): ${userDetails.username || userId} | Motif: ${reason}`);

      // 5. Notification dans le chat
      if (config.notifyChatOnAction) {
        const rawTarget = userDetails.username ? `@${userDetails.username}` : (userDetails.fullName || `ID:${userId}`);
        const targetName = escapeHtml(rawTarget);
        const safeReason = escapeHtml(reason);
        await ctx.reply(
          `⏳ <b>MISE EN SOURDINE (${durationMinutes} min)</b>\n\n` +
          `👤 Membre : ${targetName}\n` +
          `⚠️ Motif : ${safeReason}\n\n` +
          `<i>Merci de garder un langage courtois et respectueux entre fans.</i>`,
          { parse_mode: 'HTML' }
        );
      }

      return true;
    } catch (err) {
      console.error(`[ACTION] Échec de la mise en sourdine pour ${userId}:`, err.message);
      return false;
    }
  }

  /**
   * Applique un avertissement (Warn) avec sanctions progressives automatiques
   */
  static async executeWarn(ctx, userId, userDetails, reason) {
    if (await this.isImmune(ctx, userId)) {
      console.log(`[ACTION] 👑 Action impossible sur un propriétaire/administrateur du groupe : ${userId}`);
      if (ctx?.reply) {
        await ctx.reply("👑 <b>Action impossible</b> : Cet utilisateur est propriétaire ou administrateur du groupe !", { parse_mode: 'HTML' }).catch(() => {});
      }
      return false;
    }

    const warnCount = db.addWarning(userId, {
      by: ctx.from?.username || ctx.from?.first_name || 'Modérateur'
    }, reason);

    const rawTarget = userDetails.username ? `@${userDetails.username}` : (userDetails.fullName || `ID:${userId}`);
    const targetName = escapeHtml(rawTarget);
    const safeReason = escapeHtml(reason);
    const maxWarns = config.maxWarningsBeforeBan || 3;

    if (warnCount >= maxWarns) {
      // 3ème avertissement -> BAN AUTOMATIQUE
      await this.executeBan(ctx, userId, userDetails, `Accumulation de ${warnCount} avertissements : ${reason}`);
      db.clearWarnings(userId);
      return true;
    } else if (warnCount === 2) {
      // 2ème avertissement -> MUTE AUTOMATIQUE 15 MINUTES
      await this.executeMute(ctx, userId, userDetails, `2ème avertissement : ${reason}`, 15);
      return true;
    } else {
      // 1er avertissement -> Rappel à l'ordre
      await ctx.reply(
        `⚠️ <b>AVERTISSEMENT (${warnCount}/${maxWarns})</b>\n\n` +
        `👤 Membre : ${targetName}\n` +
        `📋 Motif : ${safeReason}\n\n` +
        `<i>Attention : Au 2ème avertissement, vous serez muté. Au 3ème avertissement, vous serez définitivement banni.</i>`,
        { parse_mode: 'HTML' }
      );
      return true;
    }
  }

  /**
   * Débannir un utilisateur
   */
  static async executeUnban(ctx, userId) {
    try {
      await ctx.unbanChatMember(userId, { only_if_banned: true });
      db.removeBannedUser(userId);
      console.log(`[ACTION] ✅ Utilisateur débanni : ${userId}`);
      return true;
    } catch (err) {
      console.error(`[ACTION] Échec du débannissement de ${userId}:`, err.message);
      return false;
    }
  }

  /**
   * Réactiver les permissions d'un utilisateur muté
   */
  static async executeUnmute(ctx, userId) {
    try {
      await ctx.restrictChatMember(userId, {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      });
      db.removeMutedUser(userId);
      console.log(`[ACTION] ✅ Utilisateur démute : ${userId}`);
      return true;
    } catch (err) {
      console.error(`[ACTION] Échec du dé-mute de ${userId}:`, err.message);
      return false;
    }
  }

  /**
   * Configure le mode ralenti (slowmode) du chat
   */
  static async setSlowMode(ctx, seconds) {
    try {
      await ctx.setChatSlowModeDelay(seconds);
      return true;
    } catch (err) {
      console.error('[ACTION] Erreur configuration SlowMode:', err.message);
      return false;
    }
  }

  /**
   * Verrouille ou déverrouille le groupe (Anti-Raid d'urgence)
   */
  static async setLockdown(ctx, isLocked) {
    try {
      await ctx.setChatPermissions({
        can_send_messages: !isLocked,
        can_send_audios: !isLocked,
        can_send_documents: !isLocked,
        can_send_photos: !isLocked,
        can_send_videos: !isLocked,
        can_send_video_notes: !isLocked,
        can_send_voice_notes: !isLocked,
        can_send_polls: !isLocked,
        can_send_other_messages: !isLocked,
        can_add_web_page_previews: !isLocked
      });
      return true;
    } catch (err) {
      console.error('[ACTION] Erreur configuration Lockdown:', err.message);
      return false;
    }
  }
}
