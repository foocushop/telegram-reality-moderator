import fs from 'fs';
import path from 'path';
import { InlineKeyboard, InputFile } from 'grammy';
import { config, getBotContext } from '../config.js';
import { db } from '../storage/database.js';
import { ActionManager } from '../moderation/actionManager.js';
import { escapeHtml } from '../utils/format.js';
import { geminiService } from '../ai/gemini.js';
import { conversationSessions } from '../ai/conversationSession.js';
import { AuditService } from '../services/auditService.js';
import { CloudSyncService } from '../services/cloudSyncService.js';

export class PrivateAdminManager {
  /**
   * Vérifie si l'utilisateur en chat privé a les droits d'administration
   */
  static isAuthorized(userOrId) {
    if (!userOrId) return false;
    if (db.isMaster(userOrId)) return true;
    const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
    if (!userId) return false;
    if (db.isMaster(userId)) return true;
    if (config.adminUserIds.includes(userId)) return true;
    if (db.isOwnerOrAdmin(userId)) return true;
    // Si aucun propriétaire n'a encore été enregistré, le premier utilisateur peut être autorisé
    if (!db.getOwnerId() && config.adminUserIds.length === 0) return true;
    return false;
  }

  /**
   * Génère le clavier interactif du panneau de contrôle privé
   */
  static getMainKeyboard() {
    const chatsCount = db.getManagedChats().length;
    return new InlineKeyboard()
      .text("📊 Statistiques", "p_stats")
      .text("📝 Contexte / Consignes", "p_context").row()
      .text("📺 Séries & Liens", "p_shows")
      .text("💾 Sauvegardes", "p_backup").row()
      .text(`📡 Canaux & Groupes (${chatsCount})`, "p_channels")
      .text("📢 Faire une Annonce", "p_broadcast_info").row()
      .text("🛡️ Sécurité & Filtres", "p_security")
      .text("👑 Gérer les Maîtres", "p_masters").row()
      .text("🚫 Liste des Bannis", "p_bans")
      .text("🔇 Liste des Mutes", "p_mutes").row()
      .text("🔄 Recharger", "p_reload");
  }

  /**
   * Menu principal envoyé en message privé
   */
  static async sendDashboard(ctx, isEdit = false) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply(
        "⛔ <b>Accès restreint</b> : Ce panneau est réservé au propriétaire et aux administrateurs du groupe.\n\n" +
        "💡 <i>Si vous êtes le propriétaire : écrivez un message ou tapez /admin dans votre groupe pour que le bot associe automatiquement votre compte !</i>",
        { parse_mode: 'HTML' }
      );
    }

    const isMasterUser = db.isMaster(ctx.from);
    const masters = db.getMasters();
    let ownerLabel = "🛡️ Administrateur";
    if (isMasterUser) {
      ownerLabel = "👑 MAÎTRE SUPRÊME (Dieu du bot)";
    } else if (db.getOwnerId() === userId) {
      ownerLabel = "👑 Propriétaire (Owner)";
    }

    let masterStatus = "";
    if (masters.length === 0) {
      masterStatus = "<i>Aucun maître (tapez /addmaster @pseudo)</i>";
    } else {
      masterStatus = masters
        .map(m => m.username ? `@${escapeHtml(m.username)}` : `ID:${m.id}`)
        .join(', ');
    }

    const chats = db.getManagedChats();
    const channelsCount = db.getManagedChannels().length;
    const groupsCount = db.getManagedGroups().length;
    const groupStatus = chats.length > 0
      ? `${chats.length} destination(s) (${channelsCount} canal/aux, ${groupsCount} groupe(s))`
      : "En attente d'association (ajoutez le bot admin dans vos canaux)";

    const text =
      `👑 <b>SALLE DE CONTRÔLE PRIVÉE DU BOT</b>\n\n` +
      `👤 Votre statut : <b>${ownerLabel}</b>\n` +
      `⚡ Maître(s) : <b>${masterStatus}</b>\n` +
      `📺 Destinations gérées : <b>${groupStatus}</b>\n\n` +
      `Vous pouvez tout piloter et régler ici en privé sans déranger les membres :\n` +
      `• <b>Gérer les Maîtres</b> (voir, ajouter ou supprimer les Maîtres du bot)\n` +
      `• Consulter les statistiques et les sanctions\n` +
      `• Gérer les séries et liens protégés (anti-leak)\n` +
      `• Modifier les règles et consignes du bot (<code>context.txt</code>)\n` +
      `• Publier une annonce officielle sur le groupe\n` +
      `• Régler la sécurité (slowmode, lockdown, filtres)\n` +
      `• Ou simplement <b>discuter avec moi</b> !\n\n` +
      `<i>Cliquez sur un bouton ci-dessous ou tapez une commande :</i>`;

    if (isEdit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: this.getMainKeyboard()
        });
        return;
      } catch (e) {
        // Ignorer si déjà identique
      }
    }

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: this.getMainKeyboard()
    });
  }

  /**
   * Gestion des clics sur les boutons inline en privé
   */
  static async handleCallback(ctx, action) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.answerCallbackQuery({ text: "Action non autorisée.", show_alert: true });
    }

    if (action.startsWith('p_delmaster_')) {
      const target = action.replace('p_delmaster_', '').trim();
      const removed = db.removeMaster(target);
      await ctx.answerCallbackQuery({
        text: removed ? `✅ Maître ${target} retiré avec succès !` : "⚠️ Maître introuvable.",
        show_alert: true
      });
      await this.showMastersMenu(ctx, true);
      return;
    }

    if (action.startsWith('p_delchat_')) {
      const target = action.replace('p_delchat_', '').trim();
      const removed = db.removeManagedChat(target);
      await ctx.answerCallbackQuery({
        text: removed ? `✅ Destination retirée de la liste !` : "⚠️ Destination introuvable.",
        show_alert: true
      });
      await this.sendChannelsList(ctx, true);
      return;
    }

    await ctx.answerCallbackQuery();

    switch (action) {
      case 'p_channels': {
        await this.sendChannelsList(ctx, true);
        break;
      }

      case 'p_menu':
      case 'p_main_menu': {
        await this.sendDashboard(ctx, true);
        break;
      }

      case 'p_stats': {
        const stats = db.getStats();
        await ctx.reply(
          `📊 <b>STATISTIQUES DU GROUPE EN TEMPS RÉEL</b>\n\n` +
          `💬 Messages analysés : <b>${stats.messagesScanned}</b>\n` +
          `📸 Images inspectées par l'IA : <b>${stats.imagesScanned}</b>\n` +
          `🚫 Bannissements totaux : <b>${stats.bansCount}</b>\n` +
          `⏳ Mutes totaux : <b>${stats.mutesCount}</b>\n` +
          `🌊 Floods stoppés : <b>${stats.floodIntercepted || 0}</b>\n` +
          `🔗 Liens / pubs bloqués : <b>${stats.linksBlocked || 0}</b>\n` +
          `🔒 Bannis actifs en base : <b>${stats.activeBans}</b>\n` +
          `🔇 Mutes actifs en base : <b>${stats.activeMutes}</b>\n` +
          `🤖 Moteur IA : <b>${escapeHtml(geminiService.getActiveModelName())}</b>`,
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'p_context': {
        const currentContext = getBotContext();
        await ctx.reply(
          `📝 <b>CONTEXTE ET CONSIGNES ACTUELLES DU BOT :</b>\n\n` +
          `<code>${escapeHtml(currentContext.slice(0, 3000))}</code>\n\n` +
          `💡 <b>Pour modifier ce texte directement en privé :</b>\n` +
          `• Tapez : <code>/setcontext [votre nouveau texte complet]</code>\n` +
          `• Ou tapez : <code>/addcontext [une consigne à ajouter]</code>`,
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'p_broadcast_info': {
        const chats = db.getManagedChats();
        const channelsCount = db.getManagedChannels().length;
        const groupsCount = db.getManagedGroups().length;
        const privUsersCount = db.getPrivateUsers().length;
        await ctx.reply(
          `📢 <b>DIFFUSIONS & MESSAGERIE DIRECTE</b>\n\n` +
          `1️⃣ <b>Diffusion multi-canaux & groupes :</b>\n` +
          `<code>/broadcast Votre message d'annonce ici...</code>\n` +
          `<i>Publie sur vos canaux et groupes connectés (${chats.length} au total).</i>\n\n` +
          `2️⃣ <b>Diffusion globale aux membres en MP :</b>\n` +
          `<code>/broadcast_users Votre message ici...</code>\n` +
          `<i>Envoie votre annonce en privé à tous les utilisateurs enregistrés (${privUsersCount} actuellement).</i>\n\n` +
          `3️⃣ <b>Message ciblé à une personne précise :</b>\n` +
          `<code>/send @pseudo Votre message ici...</code>\n` +
          `<i>Envoie un message privé à un membre en particulier.</i>\n\n` +
          `💡 <i>Tapez <code>/channels</code> pour voir et gérer vos canaux.</i>`,
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'p_security': {
        await ctx.reply(
          `🛡️ <b>ÉTAT DES PROTECTIONS DU GROUPE :</b>\n\n` +
          `• 🌊 <b>Anti-Flood :</b> Actif (max ${config.floodMaxMessages} msgs en ${config.floodWindowSeconds}s)\n` +
          `• 🔗 <b>Anti-Pub & Liens :</b> Actif (bloque les invitations Telegram externes et scams)\n` +
          `• 📸 <b>Vision IA NSFW :</b> Active (${config.groqVisionModel})\n` +
          `• ⚠️ <b>Avertissements Max :</b> ${config.maxWarningsBeforeBan} avertissements avant ban définitif\n\n` +
          `💡 <b>Commandes de crise disponibles en privé :</b>\n` +
          `• <code>/slowmode 15</code> : Imposer 15s de délai entre chaque message\n` +
          `• <code>/slowmode 0</code> : Désactiver le slowmode\n` +
          `• <code>/lockdown</code> : Couper la parole aux membres en urgence\n` +
          `• <code>/unlock</code> : Rétablir la parole`,
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'p_bans': {
        const bans = db.getActiveBansList();
        if (bans.length === 0) {
          return ctx.reply("✅ Aucun utilisateur banni actuellement dans la base.", { parse_mode: 'HTML' });
        }
        let text = `🚫 <b>LISTE DES MEMBRES BANNIS (${bans.length}) :</b>\n\n`;
        bans.slice(0, 15).forEach((b, i) => {
          const userStr = b.username && b.username !== 'Inconnu' ? `@${escapeHtml(b.username)}` : `ID:${b.userId}`;
          text += `${i + 1}. <b>${userStr}</b> — Motif : <i>${escapeHtml(b.reason || 'N/A')}</i>\n`;
        });
        text += `\n💡 <i>Pour débannir : tapez <code>/unban @pseudo</code> ou <code>/unban ID</code></i>`;
        await ctx.reply(text, { parse_mode: 'HTML' });
        break;
      }

      case 'p_mutes': {
        const mutes = db.getActiveMutesList();
        if (mutes.length === 0) {
          return ctx.reply("✅ Aucun membre n'est actuellement en sourdine (mute).", { parse_mode: 'HTML' });
        }
        let text = `🔇 <b>MEMBRES ACTUELLEMENT EN SOURDINE (${mutes.length}) :</b>\n\n`;
        mutes.slice(0, 15).forEach((m, i) => {
          const remainingMin = Math.max(1, Math.round((m.unmuteTimestamp - Date.now()) / 60000));
          const userStr = m.username && m.username !== 'Inconnu' ? `@${escapeHtml(m.username)}` : `ID:${m.userId}`;
          text += `${i + 1}. <b>${userStr}</b> — Reste : <b>${remainingMin} min</b> (Motif : <i>${escapeHtml(m.reason || 'N/A')}</i>)\n`;
        });
        text += `\n💡 <i>Pour dé-muter : tapez <code>/unmute @pseudo</code> ou <code>/unmute ID</code></i>`;
        await ctx.reply(text, { parse_mode: 'HTML' });
        break;
      }

      case 'p_shows': {
        await this.listShowsCommand(ctx);
        break;
      }

      case 'p_backup': {
        await this.handleBackup(ctx);
        break;
      }

      case 'p_masters':
      case 'p_master': {
        await this.showMastersMenu(ctx);
        break;
      }

      case 'p_addmaster_me': {
        db.addMaster(ctx.from);
        await ctx.answerCallbackQuery({ text: "👑 Vous êtes désormais Maître Suprême !" });
        await this.showMastersMenu(ctx, true);
        break;
      }

      case 'p_main_menu': {
        await this.sendDashboard(ctx, true);
        break;
      }

      case 'p_reload': {
        const count = ActionManager.adminCache.size;
        await ctx.reply(
          `🔄 <b>SYNCHRONISATION EFFECTUÉE !</b>\n\n` +
          `• <code>context.txt</code> relu avec succès.\n` +
          `• Cache des administrateurs et base de données à jour.`,
          { parse_mode: 'HTML' }
        );
        break;
      }
    }
  }

  /**
   * Commande administrateur pour ajouter une série / télé-réalité
   */
  static async addShowCommand(ctx, fullArgs) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    if (!fullArgs || !fullArgs.includes('|')) {
      return ctx.reply(
        `⚠️ <b>Format d'ajout d'une émission :</b>\n\n` +
        `<code>/addshow Nom de la série | Lien de visionnage | [Description optionnelle]</code>\n\n` +
        `💡 <b>Exemples :</b>\n` +
        `• <code>/addshow La Villa des Cœurs Brisés | https://lien.tv/villa | Saison 9 quotidienne</code>\n` +
        `• <code>/addshow Secret Story | https://lien.tv/secret | Épisodes et primes</code>\n` +
        `• <code>/addshow Les Cinquante | https://lien.tv/50</code>`,
        { parse_mode: 'HTML' }
      );
    }

    const parts = fullArgs.split('|').map(p => p.trim());
    const name = parts[0];
    const link = parts[1];
    const description = parts[2] || '';

    if (!name || !link) {
      return ctx.reply("⚠️ Le nom et le lien sont obligatoires. Séparez-les avec une barre verticale <code>|</code>.", { parse_mode: 'HTML' });
    }

    const show = db.addShow(name, link, description);
    if (show) {
      CloudSyncService.triggerDebouncedSave(ctx.api, 1500, 'show_added');
      await ctx.reply(
        `✅ <b>ÉMISSION AJOUTÉE AU CATALOGUE AVEC SUCCÈS !</b>\n\n` +
        `📺 <b>Nom :</b> ${escapeHtml(show.name)}\n` +
        `🔗 <b>Lien :</b> <code>${escapeHtml(show.link)}</code>\n` +
        (show.description ? `📋 <b>Description :</b> <i>${escapeHtml(show.description)}</i>\n` : '') +
        `🏷️ <b>Alias reconnus :</b> <i>${escapeHtml(show.aliases.join(', '))}</i>\n\n` +
        `🛡️ <b>Règle de sécurité :</b> Ce lien ne sera JAMAIS partagé publiquement sur le groupe. Si un membre demande cette émission dans le chat, le bot l'invitera à lui écrire en privé pour recevoir le lien !`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply("❌ Erreur lors de l'enregistrement de l'émission.");
    }
  }

  /**
   * Commande administrateur pour supprimer une série
   */
  static async delShowCommand(ctx, nameOrId) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    if (!nameOrId || nameOrId.trim().length === 0) {
      return ctx.reply("⚠️ Veuillez spécifier le nom ou l'ID de l'émission à retirer : <code>/delshow La Villa</code>", { parse_mode: 'HTML' });
    }

    const success = db.removeShow(nameOrId.trim());
    if (success) {
      CloudSyncService.triggerDebouncedSave(ctx.api, 1500, 'show_deleted');
      await ctx.reply(`✅ L'émission <b>${escapeHtml(nameOrId.trim())}</b> a été retirée du catalogue.`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`❌ Aucune émission trouvée correspondant à <b>${escapeHtml(nameOrId.trim())}</b>. Tapez /shows pour voir la liste.`, { parse_mode: 'HTML' });
    }
  }

  /**
   * Commande administrateur pour lister toutes les séries enregistrées avec leurs liens
   */
  static async listShowsCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const shows = db.getShowsList();
    if (shows.length === 0) {
      return ctx.reply(
        `📺 <b>CATALOGUE ADMINISTRATEUR (0 émission enregistrée)</b>\n\n` +
        `Vous n'avez pas encore ajouté d'émissions au catalogue.\n\n` +
        `💡 <b>Pour ajouter une émission :</b>\n` +
        `<code>/addshow Nom de la série | Lien de visionnage | [Description]</code>`,
        { parse_mode: 'HTML' }
      );
    }

    let msg = `📺 <b>CATALOGUE ADMINISTRATEUR (${shows.length} émissions) :</b>\n\n`;
    shows.forEach((s, idx) => {
      msg += `${idx + 1}. <b>${escapeHtml(s.name)}</b>\n`;
      msg += `   🔗 <code>${escapeHtml(s.link)}</code>\n`;
      if (s.description) msg += `   📋 <i>${escapeHtml(s.description)}</i>\n`;
      msg += `   🆔 ID : <code>${escapeHtml(s.id)}</code>\n\n`;
    });

    msg += `💡 <b>Actions rapides :</b>\n`;
    msg += `• Ajouter : <code>/addshow Nom | Lien | Description</code>\n`;
    msg += `• Supprimer : <code>/delshow Nom ou ID</code>\n`;
    msg += `• Sauvegarder : <code>/backup</code>`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  }

  /**
   * Menu interactif de gestion des Maîtres Suprêmes
   */
  static async showMastersMenu(ctx, isEdit = false) {
    const masters = db.getMasters();
    const keyboard = new InlineKeyboard();

    let text = `👑 <b>GESTION DES MAÎTRES SUPRÊMES DU BOT</b> ⚡\n\n` +
      `Le bot accorde à ses <b>Maîtres</b> une obéissance absolue :\n` +
      `• Il les appelle <i>« Maître »</i> ou <i>« Sa Majesté »</i>.\n` +
      `• Dans le groupe, ils peuvent bannir ou muter directement en langage naturel sans slash (ex: <i>« Tu peux bannir celui-là »</i>).\n\n` +
      `📋 <b>Liste des Maîtres actuels (${masters.length}) :</b>\n\n`;

    if (masters.length === 0) {
      text += `<i>Aucun Maître configuré pour le moment.</i>\n\n`;
    } else {
      masters.forEach((m, idx) => {
        const usernameStr = m.username ? `@${escapeHtml(m.username)}` : '<i>Sans @</i>';
        const idStr = m.id ? `(ID: <code>${m.id}</code>)` : '<i>(ID non lié)</i>';
        text += `${idx + 1}. <b>${usernameStr}</b> ${idStr}\n`;
        const removeKey = m.username ? m.username : m.id;
        keyboard.text(`🗑️ Retirer ${m.username ? '@' + m.username : 'ID ' + m.id}`, `p_delmaster_${removeKey}`).row();
      });
      text += '\n';
    }

    text += `🛠️ <b>Commandes disponibles :</b>\n` +
      `• Ajouter : <code>/addmaster @pseudo</code>\n` +
      `• Vous ajouter : <code>/addmaster me</code>\n` +
      `• Retirer : <code>/delmaster @pseudo</code> ou <code>/delmaster ID</code>\n` +
      `• Lister : <code>/masters</code>`;

    const isCurrentMaster = db.isMaster(ctx.from);
    if (!isCurrentMaster) {
      keyboard.text("➕ M'ajouter comme Maître", "p_addmaster_me").row();
    }
    keyboard.text("🔙 Retour au Menu", "p_main_menu");

    if (isEdit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch (e) {
        // Ignorer si échec d'édition
      }
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  /**
   * Commande administrateur pour lister les Maîtres
   */
  static async listMastersCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }
    return this.showMastersMenu(ctx, false);
  }

  /**
   * Ajoute un Maître Suprême (@username ou ID)
   */
  static async addMasterCommand(ctx, arg) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const cleanArg = (arg || '').trim();
    if (!cleanArg) {
      return ctx.reply(
        `👑 <b>Ajouter un Maître Suprême :</b>\n\n` +
        `Usage : <code>/addmaster @pseudo</code> ou <code>/addmaster me</code>\n\n` +
        `Exemple : <code>/addmaster @gankpai</code>\n` +
        `Tapez <code>/masters</code> pour voir la liste actuelle.`,
        { parse_mode: 'HTML' }
      );
    }

    let target = cleanArg;
    if (cleanArg.toLowerCase() === 'me') {
      if (ctx.from?.username) {
        target = `@${ctx.from.username}`;
      } else if (userId) {
        target = String(userId);
      }
    }

    const res = db.addMaster(target);
    if (res) {
      const display = res.username ? `@${res.username}` : `ID: ${res.id}`;
      await ctx.reply(
        `👑✨ <b>NOUVEAU MAÎTRE ENREGISTRÉ !</b>\n\n` +
        `Le compte <b>${escapeHtml(display)}</b> est désormais le <b>Maître Suprême</b> du bot !\n\n` +
        `Désormais :\n` +
        `• Léna vous appellera <i>« Maître »</i> ou <i>« Sa Majesté »</i>.\n` +
        `• Dans le groupe ou en répondant à un message, vous pouvez dire : <i>« Tu peux bannir celui-là »</i>, et votre ordre sera exécuté sur-le-champ ! ⚡\n\n` +
        `Tapez <code>/masters</code> pour voir la liste des maîtres.`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply("❌ Impossible de configurer ce maître. Spécifiez un @pseudo ou un ID valide.", { parse_mode: 'HTML' });
    }
  }

  /**
   * Supprime un Maître Suprême (@username ou ID)
   */
  static async delMasterCommand(ctx, arg) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const cleanArg = (arg || '').trim();
    if (!cleanArg) {
      return ctx.reply(
        `🗑️ <b>Retirer un Maître Suprême :</b>\n\n` +
        `Usage : <code>/delmaster @pseudo</code> ou <code>/delmaster ID</code>\n\n` +
        `Tapez <code>/masters</code> pour voir la liste des maîtres actifs.`,
        { parse_mode: 'HTML' }
      );
    }

    let target = cleanArg;
    if (cleanArg.toLowerCase() === 'me') {
      if (ctx.from?.username) {
        target = `@${ctx.from.username}`;
      } else if (userId) {
        target = String(userId);
      }
    }

    const removed = db.removeMaster(target);
    if (removed) {
      await ctx.reply(
        `✅ <b>Maître retiré avec succès !</b>\n\n` +
        `Le compte <code>${escapeHtml(target)}</code> n'a plus les privilèges de Maître Suprême.\n` +
        `Tapez <code>/masters</code> pour voir la liste à jour.`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(
        `⚠️ Aucun maître correspondant à <code>${escapeHtml(target)}</code> n'a été trouvé.\n` +
        `Tapez <code>/masters</code> pour vérifier les maîtres existants.`,
        { parse_mode: 'HTML' }
      );
    }
  }

  /**
   * Définit le Maître Suprême (alias pour addMasterCommand)
   */
  static async setMasterCommand(ctx, arg) {
    return this.addMasterCommand(ctx, arg);
  }

  /**
   * Crée un instantané de sauvegarde et affiche les informations de sécurité
   */
  static async handleBackup(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const backupRes = db.createBackup("Sauvegarde manuelle administrateur");
    const shows = db.getShowsList();

    let msg = `💾 <b>SYSTÈME DE SAUVEGARDE & PERSISTANCE ACTIVE</b> 🛡️\n\n`;
    if (backupRes) {
      msg += `✅ <b>Nouvelle sauvegarde créée avec succès !</b>\n`;
      msg += `📁 Fichier d'archive : <code>${escapeHtml(backupRes.filename)}</code>\n`;
      msg += `📺 Séries sauvegardées : <b>${backupRes.showsCount} émission(s)</b>\n`;
      msg += `🕒 Date : <code>${new Date(backupRes.timestamp).toLocaleString('fr-FR')}</code>\n\n`;
    }

    msg += `🔒 <b>Comment vos liens sont protégés en continu :</b>\n`;
    msg += `1️⃣ <b>Double redondance :</b> Chaque ajout/suppression est écrit simultanément dans <code>moderation_db.json</code> ET dans <code>shows_catalog.json</code>.\n`;
    msg += `2️⃣ <b>Historique de secours :</b> Le dossier <code>data/backups/</code> conserve les 10 dernières sauvegardes horodatées.\n`;
    msg += `3️⃣ <b>Restauration automatique :</b> Si le bot redémarre ou subit une mise à jour, il recharge automatiquement vos séries sans perte de données.\n`;
    msg += `4️⃣ <b>Isolation totale des tests :</b> Les tests de développement utilisent désormais leur propre base séparée et ne touchent JAMAIS à vos vrais liens.\n\n`;
    msg += `💡 <b>Commandes disponibles :</b>\n`;
    msg += `• <code>/backup</code> : Déclencher un instantané immédiat\n`;
    msg += `• <code>/backups</code> : Voir l'historique des sauvegardes\n`;
    msg += `• <code>/restoreshows</code> : Restaurer les séries depuis la dernière sauvegarde`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  }

  /**
   * Affiche l'historique des sauvegardes
   */
  static async listBackupsCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const backups = db.listBackups();
    if (backups.length === 0) {
      return ctx.reply("📁 Aucune archive de sauvegarde pour le moment. Tapez /backup pour en créer une.", { parse_mode: 'HTML' });
    }

    let msg = `📁 <b>HISTORIQUE DES SAUVEGARDES (${backups.length}) :</b>\n\n`;
    backups.slice(0, 10).forEach((b, idx) => {
      const dateStr = b.timestamp ? new Date(b.timestamp).toLocaleString('fr-FR') : 'Date inconnue';
      msg += `${idx + 1}. <code>${escapeHtml(b.filename)}</code>\n`;
      msg += `   📺 ${b.showsCount} émission(s) | Motif : <i>${escapeHtml(b.reason)}</i>\n`;
      msg += `   🕒 ${dateStr}\n\n`;
    });

    msg += `💡 Pour restaurer la dernière sauvegarde : tapez <code>/restoreshows</code>`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
  }

  /**
   * Restaure les séries depuis le dernier backup ou catalogue miroir
   */
  static async restoreShowsCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const restored = db.restoreFromLatestBackup();
    const shows = db.getShowsList();

    if (restored || shows.length > 0) {
      await ctx.reply(
        `✅ <b>RESTAURATION RÉUSSIE !</b>\n\n` +
        `📺 <b>${shows.length} émission(s)</b> sont actuellement chargées et actives dans votre catalogue.\n` +
        `Tapez <code>/shows</code> pour vérifier la liste complète.`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(
        `⚠️ Aucune sauvegarde précédente n'a pu être trouvée. Tapez <code>/addshow</code> pour ajouter de nouvelles émissions.`,
        { parse_mode: 'HTML' }
      );
    }
  }

  /**
   * Exporte le catalogue sous forme de fichier JSON directement dans Telegram
   */
  static async exportShowsCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const shows = db.getShowsList();
    const jsonStr = db.exportShowsJson();
    const buffer = Buffer.from(jsonStr, 'utf-8');

    await ctx.replyWithDocument(
      new InputFile(buffer, `shows_catalog_${new Date().toISOString().slice(0, 10)}.json`),
      {
        caption:
          `📦 <b>SAUVEGARDE DU CATALOGUE TÉLÉ-RÉALITÉ</b>\n\n` +
          `📺 Contient <b>${shows.length} émission(s)</b> actives.\n\n` +
          `💡 <b>Comment restaurer en cas de redéploiement Render :</b>\n` +
          `Renvoyez simplement ce fichier <code>.json</code> au bot ici en message privé, et toutes vos séries seront restaurées en 1 seconde !`,
        parse_mode: 'HTML'
      }
    );
  }

  /**
   * Importe un fichier de sauvegarde JSON envoyé par l'administrateur
   */
  static async handleJsonFileImport(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const doc = ctx.message?.document;
    if (!doc || !doc.file_name?.toLowerCase().endsWith('.json')) {
      return;
    }

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const res = await fetch(fileUrl);
      const content = await res.text();
      const parsed = JSON.parse(content);

      let replyMsg = '';
      if (parsed.moderation_db || parsed.shows_catalog) {
        db.restoreFullState(parsed);
        const totalShows = db.getShowsList().length;
        const totalUsers = Object.keys(db.data.knownUsers || {}).length;
        const privUsers = Object.keys(db.data.privateUsers || {}).length;
        replyMsg =
          `✅ <b>RESTAURATION COMPLÈTE DU BOT EFFECTUÉE !</b> 🚀\n\n` +
          `👥 <b>${privUsers}</b> membre(s) privé(s) (<b>${totalUsers}</b> connus) restaurés.\n` +
          `📺 <b>${totalShows}</b> émission(s) actives dans le catalogue.\n` +
          `🛡️ <i>Toutes les données ont été réinjectées et synchronisées.</i>`;
      } else {
        const importedCount = db.importShows(parsed);
        const totalShows = db.getShowsList().length;
        replyMsg =
          `✅ <b>IMPORTATION DU CATALOGUE RÉUSSIE !</b> 🎉\n\n` +
          `📥 <b>${importedCount} émission(s)</b> importées ou mises à jour depuis votre fichier.\n` +
          `📺 <b>Total actif dans le catalogue :</b> <b>${totalShows}</b> émission(s).\n\n` +
          `Tapez <code>/shows</code> pour vérifier votre catalogue complet !`;
      }

      CloudSyncService.triggerDebouncedSave(ctx.api, 1500, 'file_imported');
      return ctx.reply(replyMsg, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[ADMIN] Erreur import JSON:', err);
      return ctx.reply(`❌ <b>Erreur lors de l'importation du fichier JSON :</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  }

  /**
   * Modifie ou ajoute du texte au fichier context.txt directement depuis Telegram
   */
  static async updateContext(ctx, newText, isAppend = false) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès refusé.");
    }

    if (!newText || newText.trim().length === 0) {
      return ctx.reply("⚠️ Veuillez spécifier le texte à enregistrer. Exemple : <code>/setcontext Mon nouveau contexte...</code>", { parse_mode: 'HTML' });
    }

    try {
      const contextPath = path.resolve('context.txt');
      let finalContent = newText.trim();

      if (isAppend && fs.existsSync(contextPath)) {
        const current = fs.readFileSync(contextPath, 'utf-8');
        finalContent = `${current}\n\n# --- Ajout du ${new Date().toLocaleDateString('fr-FR')} ---\n${finalContent}`;
      }

      fs.writeFileSync(contextPath, finalContent, 'utf-8');

      await ctx.reply(
        `✅ <b>CONTEXTE MIS À JOUR AVEC SUCCÈS !</b>\n\n` +
        `Le bot a immédiatement pris en compte vos nouvelles consignes sans redémarrage.\n\n` +
        `📄 <b>Aperçu :</b>\n<code>${escapeHtml(finalContent.slice(0, 500))}...</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[PRIVATE ADMIN] Erreur écriture context.txt:', err);
      await ctx.reply(`❌ Erreur lors de l'écriture du fichier : ${err.message}`);
    }
  }

  /**
   * Envoie une annonce officielle dans TOUS les canaux et groupes Telegram gérés
   */
  static async broadcastToAll(ctx, announcementText) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès refusé.");
    }

    const chats = db.getManagedChats();
    if (!chats || chats.length === 0) {
      return ctx.reply(
        "⚠️ <b>Aucun canal ni groupe n'est encore associé !</b>\n\n" +
        "Pour associer un canal ou groupe :\n" +
        "• Ajoutez le bot comme <b>Administrateur</b> dans votre canal / groupe (avec droit de publication)\n" +
        "• Ou tapez <code>/addchannel @nom_du_canal</code>\n" +
        "• Ou transférez n'importe quel message de votre canal ici en privé",
        { parse_mode: 'HTML' }
      );
    }

    if (!announcementText || announcementText.trim().length === 0) {
      return ctx.reply(
        "⚠️ Veuillez écrire le message de l'annonce.\nExemple : <code>/broadcast Ce soir prime à 20h en direct !</code>",
        { parse_mode: 'HTML' }
      );
    }

    const broadcastMessage =
      `📢 <b>ANNONCE OFFICIELLE DU CANAL</b> 📺✨\n\n` +
      `${escapeHtml(announcementText.trim())}\n\n` +
      `<i>— La Direction & Léna ✨ (+ = +)</i>`;

    const successes = [];
    const failures = [];

    // Notification temporaire de progression si plusieurs chats
    let progressMsg = null;
    if (chats.length > 1) {
      progressMsg = await ctx.reply(
        `⏳ <b>Diffusion en cours vers ${chats.length} destination(s)...</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
    }

    for (const chat of chats) {
      try {
        await ctx.api.sendMessage(chat.id, broadcastMessage, { parse_mode: 'HTML' });
        successes.push(chat);
      } catch (err) {
        console.error(`[BROADCAST] Erreur envoi vers ${chat.title} (${chat.id}):`, err.message);
        failures.push({ chat, error: err.message });

        // Si le bot a été expulsé ou si le chat n'existe plus, nettoyer automatiquement
        const isDeadChat =
          err.message.includes('chat not found') ||
          err.message.includes('bot was kicked') ||
          err.message.includes('bot was blocked') ||
          err.message.includes('chat was deleted');
        if (isDeadChat) {
          console.warn(`[BROADCAST] 🧹 Retrait automatique du chat inactif : ${chat.id} (${chat.title})`);
          db.removeManagedChat(chat.id);
        }
      }
    }

    if (progressMsg) {
      await ctx.api.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
    }

    // Rapport détaillé à l'administrateur
    let report = `📢 <b>RAPPORT DE DIFFUSION</b> 📡\n\n`;
    report += `Message diffusé avec succès à <b>${successes.length}/${chats.length}</b> destination(s).\n\n`;

    if (successes.length > 0) {
      report += `✅ <b>Envoyé avec succès à :</b>\n`;
      successes.forEach(c => {
        const icon = c.type === 'channel' ? '📢' : '👥';
        report += `• ${icon} <b>${escapeHtml(c.title || 'Canal')}</b> (ID: <code>${c.id}</code>)\n`;
      });
      report += `\n`;
    }

    if (failures.length > 0) {
      report += `❌ <b>Échecs (${failures.length}) :</b>\n`;
      failures.forEach(f => {
        const icon = f.chat?.type === 'channel' ? '📢' : '👥';
        report += `• ${icon} <b>${escapeHtml(f.chat?.title || 'Inconnu')}</b> : <i>${escapeHtml(f.error)}</i>\n`;
      });
      report += `\n💡 <i>Vérifiez que le bot est bien administrateur avec la permission de poster des messages dans ces canaux/groupes.</i>`;
    }

    await ctx.reply(report, { parse_mode: 'HTML' });
  }

  /**
   * Alias de compatibilité pour broadcastToAll
   */
  static async broadcastToGroup(ctx, announcementText) {
    return this.broadcastToAll(ctx, announcementText);
  }

  /**
   * Envoie un message privé ciblé à un utilisateur précis via son @username ou ID
   */
  static async sendDirectMessage(ctx, fullArgs) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const cleanArgs = (fullArgs || '').trim();
    const firstSpaceIdx = cleanArgs.indexOf(' ');

    if (!cleanArgs || firstSpaceIdx === -1) {
      return ctx.reply(
        `✉️ <b>ENVOI D'UN MESSAGE PRIVÉ CIBLÉ</b>\n\n` +
        `📝 <b>Utilisation :</b>\n` +
        `<code>/send @pseudo Votre message ici...</code>\n` +
        `ou\n` +
        `<code>/send ID_UTILISATEUR Votre message ici...</code>\n\n` +
        `💡 <b>Exemples :</b>\n` +
        `• <code>/send @GrandJD Coucou ! Ton lien exclusif est prêt.</code>\n` +
        `• <code>/send 5514712683 Bonjour, merci pour ton retour !</code>\n\n` +
        `<i>Le bot distribuera directement votre message en privé à cette personne.</i>`,
        { parse_mode: 'HTML' }
      );
    }

    const targetArg = cleanArgs.slice(0, firstSpaceIdx).trim();
    const messageToSend = cleanArgs.slice(firstSpaceIdx).trim();

    if (!messageToSend) {
      return ctx.reply("⚠️ Veuillez spécifier le message à envoyer après l'identifiant.", { parse_mode: 'HTML' });
    }

    let targetUserId = null;
    let targetDetails = null;

    if (/^-?\d+$/.test(targetArg)) {
      targetUserId = Number(targetArg);
      targetDetails = db.getUserDetails(targetUserId);
    } else {
      const cleanUsername = targetArg.replace(/^@/, '').toLowerCase().trim();
      targetUserId = db.getUserIdByUsername(cleanUsername);
      if (targetUserId) {
        targetDetails = db.getUserDetails(targetUserId);
      } else {
        const privUsers = db.getPrivateUsers();
        const found = privUsers.find(u => u.username && u.username.toLowerCase() === cleanUsername);
        if (found) {
          targetUserId = found.userId;
          targetDetails = found;
        }
      }
    }

    if (!targetUserId) {
      return ctx.reply(
        `❌ <b>Utilisateur introuvable :</b> <code>${escapeHtml(targetArg)}</code>\n\n` +
        `👉 <i>Le bot ne peut envoyer de message qu'aux membres ayant déjà au moins une fois lancé le bot en privé (/start ou message) ou actifs dans le groupe.</i>`,
        { parse_mode: 'HTML' }
      );
    }

    const targetDisplay = targetDetails?.username
      ? `@${escapeHtml(targetDetails.username)}`
      : (targetDetails?.fullName ? `<b>${escapeHtml(targetDetails.fullName)}</b>` : `<code>${targetUserId}</code>`);

    try {
      await ctx.api.sendMessage(targetUserId, messageToSend, { parse_mode: 'HTML' });
    } catch (sendErr) {
      try {
        await ctx.api.sendMessage(targetUserId, messageToSend);
      } catch (rawErr) {
        return ctx.reply(
          `❌ <b>Échec de distribution à ${targetDisplay} :</b>\n\n` +
          `<code>${escapeHtml(rawErr.message)}</code>\n\n` +
          `👉 <i>L'utilisateur a probablement bloqué le bot ou ne l'a jamais démarré en privé.</i>`,
          { parse_mode: 'HTML' }
        );
      }
    }

    // Journalisation dans l'Audit (Render + Canal d'audit)
    await AuditService.logPrivateInteraction(
      { from: { id: targetUserId, username: targetDetails?.username, first_name: targetDetails?.fullName || 'Membre' }, api: ctx.api },
      `[ENVOI ADMINISTRATEUR MANUEL par ${ctx.from?.first_name || 'Admin'}]`,
      messageToSend,
      { tag: 'ADMIN_DIRECT_SEND' }
    );

    return ctx.reply(
      `✅ <b>Message privé envoyé avec succès !</b> 🚀\n\n` +
      `👤 <b>Destinataire :</b> ${targetDisplay} (ID: <code>${targetUserId}</code>)\n` +
      `💬 <b>Contenu :</b>\n<i>"${escapeHtml(messageToSend)}"</i>`,
      { parse_mode: 'HTML' }
    );
  }

  /**
   * Diffuse un message à TOUS les utilisateurs ayant discuté avec le bot en privé
   */
  static async broadcastToUsers(ctx, announcementText) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const cleanText = (announcementText || '').trim();
    if (!cleanText) {
      const privateUsersCount = db.getPrivateUsers().length;
      return ctx.reply(
        `📢 <b>DIFFUSION GLOBALE AUX UTILISATEURS (MESSAGES PRIVÉS)</b>\n\n` +
        `👥 Utilisateurs enregistrés éligibles : <b>${privateUsersCount}</b>\n\n` +
        `📝 <b>Utilisation :</b>\n` +
        `<code>/broadcast_users Votre annonce ici...</code>\n\n` +
        `💡 <i>Chaque membre recevra ce message directement dans sa boîte privée avec Léna. Tapez <code>/sync_users</code> pour synchroniser aussi les anciens membres connus du groupe.</i>`,
        { parse_mode: 'HTML' }
      );
    }

    const privateUsers = db.getPrivateUsers();
    if (privateUsers.length === 0) {
      return ctx.reply(
        "⚠️ <b>Aucun utilisateur privé enregistré pour le moment.</b>\n\n" +
        "Dès que des membres envoient un message au bot ou cliquent sur /start, ils seront automatiquement enregistrés.",
        { parse_mode: 'HTML' }
      );
    }

    const statusMsg = await ctx.reply(`🚀 <b>Diffusion en cours vers ${privateUsers.length} utilisateur(s)...</b>`, { parse_mode: 'HTML' });

    let successCount = 0;
    let failCount = 0;
    const blockedUserIds = [];

    for (const u of privateUsers) {
      try {
        await ctx.api.sendMessage(u.userId, cleanText, { parse_mode: 'HTML' });
        successCount++;
      } catch (err) {
        try {
          await ctx.api.sendMessage(u.userId, cleanText);
          successCount++;
        } catch (subErr) {
          failCount++;
          if (subErr.message && (subErr.message.includes('blocked') || subErr.message.includes('deactivated') || subErr.message.includes('not found') || subErr.message.includes('Forbidden'))) {
            blockedUserIds.push(u.userId);
          }
        }
      }
      // Pause de cadence anti-flood
      await new Promise(r => setTimeout(r, 40));
    }

    // Marquage non destructif des utilisateurs inaccessibles (aucun compte n'est supprimé de la base !)
    if (blockedUserIds.length > 0) {
      blockedUserIds.forEach(id => db.markPrivateUserReachable(id, false, 'forbidden_or_blocked'));
    }

    const report =
      `📢 <b>RAPPORT DE DIFFUSION UTILISATEURS (MP)</b>\n\n` +
      `✅ <b>Distribués avec succès :</b> <b>${successCount}</b>\n` +
      `❌ <b>Échecs / Bloqués :</b> <b>${failCount}</b>\n` +
      `📊 <b>Total des membres ciblés :</b> <b>${privateUsers.length}</b>\n` +
      (blockedUserIds.length > 0 ? `🛡️ <i>${blockedUserIds.length} compte(s) temporairement inaccessibles (conservés en base).</i>\n\n` : '\n') +
      `💬 <b>Message diffusé :</b>\n<i>"${escapeHtml(cleanText.slice(0, 300))}${cleanText.length > 300 ? '...' : ''}"</i>`;

    try {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch {}

    return ctx.reply(report, { parse_mode: 'HTML' });
  }

  /**
   * Synchronise manuellement les utilisateurs connus du groupe vers la liste d'envoi privé
   */
  static async syncUsersCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const added = db.syncKnownUsersToPrivate();
    const total = db.getPrivateUsers().length;

    return ctx.reply(
      `🔄 <b>SYNCHRONISATION DES MEMBRES HISTORIQUES</b>\n\n` +
      `✅ <b>${added}</b> nouvel(s) utilisateur(s) synchronisé(s) !\n` +
      `👥 Total des destinataires éligibles : <b>${total}</b>\n\n` +
      `💡 <i>Lors du prochain <code>/broadcast_users</code>, le bot tentera également de leur délivrer le message. Ceux qui n'ont jamais ouvert le bot en privé ou qui l'ont bloqué seront automatiquement nettoyés sans bloquer la diffusion.</i>`,
      { parse_mode: 'HTML' }
    );
  }

  /**
   * Envoie la liste des canaux et groupes gérés avec gestion interactive
   */
  static async sendChannelsList(ctx, isEdit = false) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès refusé.");
    }

    const chats = db.getManagedChats();
    const keyboard = new InlineKeyboard();

    let text = `📡 <b>CANAUX ET GROUPES GÉRÉS (${chats.length}) :</b>\n\n`;
    text += `Le bot diffusera toutes les annonces (<code>/broadcast</code>) vers chacune de ces destinations où il est administrateur.\n\n`;

    if (chats.length === 0) {
      text += `<i>Aucun canal ou groupe n'est enregistré pour le moment.</i>\n\n`;
    } else {
      chats.forEach((c, idx) => {
        const icon = c.type === 'channel' ? '📢' : '👥';
        const typeLabel = c.type === 'channel' ? 'Canal' : 'Groupe';
        const userStr = c.username ? ` (@${escapeHtml(c.username)})` : '';
        text += `${idx + 1}. ${icon} <b>${escapeHtml(c.title || typeLabel)}</b>${userStr}\n`;
        text += `   • ID : <code>${c.id}</code> | Type : <i>${typeLabel}</i>\n`;

        keyboard.text(`🗑️ Retirer #${idx + 1} (${(c.title || typeLabel).slice(0, 15)})`, `p_delchat_${c.id}`).row();
      });
      text += `\n`;
    }

    const auditId = db.getEffectiveAuditChannelId();
    text += `🕵️ <b>CANAL D'AUDIT PRIVÉ (Surveillance MP) :</b>\n`;
    if (auditId) {
      text += `• Statut : <b>✅ Actif</b> (ID : <code>${auditId}</code>)\n`;
      text += `• <i>Tapez <code>/testaudit</code> pour tester ou <code>/unsetaudit</code> pour désactiver.</i>\n\n`;
    } else {
      text += `• Statut : <i>Non configuré (Logs console Render seuls)</i>\n`;
      text += `• <i>Pour recevoir une copie des messages privés dans un canal : tapez <code>/setaudit ID_CANAL</code></i>\n\n`;
    }

    text += `➕ <b>COMMENT AJOUTER UN NOUVEAU CANAL OU GROUPE :</b>\n` +
      `1️⃣ <b>Méthode automatique :</b> Ajoutez le bot comme <b>Administrateur</b> dans votre canal ou groupe (avec le droit de publier des messages). Le bot l'enregistre instantanément !\n` +
      `2️⃣ <b>Méthode transfert :</b> Transférez n'importe quel message de votre canal directement ici dans cette discussion privée avec le bot.\n` +
      `3️⃣ <b>Méthode commande :</b> Tapez <code>/addchannel @nom_du_canal</code> ou <code>/addchannel -100xxxxxxxxxx</code>\n\n` +
      `💡 <i>Pour diffuser une annonce à tous vos canaux : tapez <code>/broadcast Votre message</code></i>`;

    keyboard.text("🔄 Rafraîchir", "p_channels")
      .text("🔙 Retour au Menu", "p_menu");

    if (isEdit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'HTML' });
        return;
      } catch (e) {}
    }

    await ctx.reply(text, { reply_markup: keyboard, parse_mode: 'HTML' });
  }

  /**
   * Commande manuelle pour ajouter un canal ou un groupe
   */
  static async addChannelManually(ctx, targetInput) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès refusé.");
    }

    const cleanInput = (targetInput || '').trim();
    if (!cleanInput) {
      return ctx.reply(
        "⚠️ <b>Utilisation :</b> <code>/addchannel @nom_du_canal</code> ou <code>/addchannel -100xxxxxxxxxx</code>\n\n" +
        "💡 Vous pouvez aussi simplement <b>transférer ici un message</b> venant du canal !",
        { parse_mode: 'HTML' }
      );
    }

    try {
      // 1. Récupérer les informations du chat auprès de Telegram
      const chat = await ctx.api.getChat(cleanInput);
      if (!chat) {
        return ctx.reply(`❌ Impossible de trouver le chat "${cleanInput}".`);
      }

      // 2. Vérifier si le bot est présent et a les droits
      let botMember;
      try {
        const botInfo = ctx.me || await ctx.api.getMe();
        botMember = await ctx.api.getChatMember(chat.id, botInfo.id);
      } catch (err) {
        return ctx.reply(
          `❌ <b>Le bot n'a pas accès à ce canal / groupe !</b>\n\n` +
          `Vérifiez que vous avez bien ajouté le bot comme <b>Administrateur</b> dans le canal avec la permission de publier des messages.`,
          { parse_mode: 'HTML' }
        );
      }

      const isBotAdmin = ['administrator', 'creator'].includes(botMember?.status);
      if (!isBotAdmin) {
        return ctx.reply(
          `⚠️ <b>Attention :</b> Le bot est dans <b>${escapeHtml(chat.title || cleanInput)}</b> mais n'est <b>pas Administrateur</b>.\n` +
          `Veuillez le promouvoir administrateur dans les réglages du canal pour qu'il puisse publier des annonces !`,
          { parse_mode: 'HTML' }
        );
      }

      // 3. Enregistrer dans la base de données
      const title = chat.title || cleanInput;
      const type = chat.type || 'channel';
      const username = chat.username || null;
      db.addManagedChat(chat.id, title, type, username);

      return ctx.reply(
        `✅ <b>Canal / Groupe connecté avec succès !</b> 📡\n\n` +
        `• <b>Nom :</b> ${escapeHtml(title)}\n` +
        `• <b>Type :</b> ${type === 'channel' ? '📢 Canal' : '👥 Groupe'}\n` +
        `• <b>ID :</b> <code>${chat.id}</code>\n` +
        (username ? `• <b>Username :</b> @${escapeHtml(username)}\n` : '') +
        `\nIl recevra désormais automatiquement toutes les diffusions envoyées via <code>/broadcast</code> !`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[ADMIN] Erreur addChannelManually:', err);
      return ctx.reply(`❌ Erreur lors de l'ajout du canal : ${err.message}`);
    }
  }

  /**
   * Commande manuelle pour retirer un canal ou groupe
   */
  static async removeChannelManually(ctx, targetInput) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(userId)) {
      return ctx.reply("⛔ Accès refusé.");
    }

    const cleanInput = (targetInput || '').trim();
    if (!cleanInput) {
      return ctx.reply(
        "⚠️ <b>Utilisation :</b> <code>/delchannel ID_OU_NOM</code> (voir la liste dans /channels)",
        { parse_mode: 'HTML' }
      );
    }

    let targetId = null;
    const chats = db.getManagedChats();

    if (/^-?\d+$/.test(cleanInput)) {
      targetId = Number(cleanInput);
    } else {
      const needle = cleanInput.replace(/^@/, '').toLowerCase();
      const found = chats.find(c =>
        (c.username && c.username.toLowerCase() === needle) ||
        (c.title && c.title.toLowerCase().includes(needle))
      );
      if (found) targetId = found.id;
    }

    if (!targetId) {
      return ctx.reply(`❌ Aucun canal ou groupe trouvé correspondant à "${cleanInput}". Tapez /channels pour voir la liste.`);
    }

    const removed = db.removeManagedChat(targetId);
    if (removed) {
      return ctx.reply(`✅ Le canal/groupe (ID: <code>${targetId}</code>) a été retiré de la liste de diffusion.`, { parse_mode: 'HTML' });
    } else {
      return ctx.reply(`⚠️ Impossible de retirer le canal/groupe (ID: <code>${targetId}</code>).`);
    }
  }

  /**
   * Commande manuelle pour configurer le canal d'audit dédié
   */
  static async setAuditChannelCommand(ctx, input) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const cleanInput = (input || '').trim();
    if (!cleanInput) {
      const currentAuditId = db.getEffectiveAuditChannelId();
      return ctx.reply(
        `🕵️ <b>CONFIGURATION DU CANAL D'AUDIT PRIVÉ</b>\n\n` +
        (currentAuditId ? `• Canal d'audit actuel : <code>${currentAuditId}</code>\n\n` : `• Statut actuel : <i>Aucun canal configuré</i>\n\n`) +
        `📝 <b>Utilisation :</b> <code>/setaudit ID_OU_NOM_CANAL</code>\n` +
        `<i>Exemple :</i> <code>/setaudit -1001234567890</code>\n\n` +
        `💡 <b>Étapes :</b>\n` +
        `1. Créez un canal privé Telegram (ex: "Audit Bot Léna").\n` +
        `2. Ajoutez le bot comme <b>Administrateur</b> avec la permission de publier des messages.\n` +
        `3. Tapez <code>/setaudit ID_DU_CANAL</code> ou <code>/setaudit @nom_du_canal</code>.\n` +
        `4. Le bot enverra immédiatement un message de confirmation dans le canal !`,
        { parse_mode: 'HTML' }
      );
    }

    try {
      // 1. Récupérer les informations du chat
      const chat = await ctx.api.getChat(cleanInput);
      if (!chat) {
        return ctx.reply(`❌ Impossible de trouver le canal "${cleanInput}".`);
      }

      // 2. Tester l'envoi d'un message pour valider les droits administrateurs
      try {
        await AuditService.sendTestMessage(ctx.api, chat.id);
      } catch (sendErr) {
        return ctx.reply(
          `❌ <b>Échec de validation des droits d'écriture !</b>\n\n` +
          `Le bot n'a pas pu publier dans le canal <b>${escapeHtml(chat.title || cleanInput)}</b>.\n\n` +
          `👉 <i>Veuillez vérifier que le bot est bien ajouté en tant qu'<b>Administrateur</b> avec l'autorisation de publier des messages.</i>\n\n` +
          `Détail de l'erreur : <code>${escapeHtml(sendErr.message)}</code>`,
          { parse_mode: 'HTML' }
        );
      }

      // 3. Sauvegarder dans la base de données
      db.setAuditChannelId(chat.id);

      return ctx.reply(
        `✅ <b>Canal d'audit configuré avec succès !</b> 🕵️📡\n\n` +
        `• <b>Canal :</b> ${escapeHtml(chat.title || cleanInput)}\n` +
        `• <b>ID :</b> <code>${chat.id}</code>\n\n` +
        `🎉 <b>Un message de validation a été envoyé dans le canal.</b>\n` +
        `Désormais, tous les messages privés échangés entre les membres et Léna y seront fidèlement transmis en direct !`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[ADMIN] Erreur setAuditChannelCommand:', err);
      return ctx.reply(`❌ Erreur lors de la configuration du canal d'audit : ${err.message}`);
    }
  }

  /**
   * Commande manuelle pour tester le canal d'audit
   */
  static async testAuditChannelCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const auditChannelId = db.getEffectiveAuditChannelId();
    if (!auditChannelId) {
      return ctx.reply(
        "⚠️ <b>Aucun canal d'audit n'est configuré pour le moment.</b>\n\n" +
        "Pour en définir un, tapez : <code>/setaudit ID_DU_CANAL</code>",
        { parse_mode: 'HTML' }
      );
    }

    try {
      await AuditService.sendTestMessage(ctx.api, auditChannelId);
      return ctx.reply(
        `✅ <b>Test réussi !</b> Un message de vérification vient d'être publié dans votre canal d'audit (<code>${auditChannelId}</code>).`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      return ctx.reply(
        `❌ <b>Erreur lors du test :</b> ${escapeHtml(err.message)}\n\n` +
        `Vérifiez que le bot est toujours administrateur dans le canal <code>${auditChannelId}</code>.`,
        { parse_mode: 'HTML' }
      );
    }
  }

  /**
   * Commande manuelle pour désactiver le canal d'audit
   */
  static async unsetAuditChannelCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    db.setAuditChannelId(null);
    return ctx.reply(
      "✅ <b>Le relais vers le canal d'audit Telegram a été désactivé.</b>\n\n" +
      "💡 Les échanges privés continueront d'apparaître normalement dans vos logs Render.",
      { parse_mode: 'HTML' }
    );
  }

  /**
   * Définit explicitement le canal ou chat de stockage persistant Cloud
   */
  static async setStorageCommand(ctx, input) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const cleanInput = (input || '').trim();
    if (!cleanInput) {
      const current = CloudSyncService.getStorageChatId();
      return ctx.reply(
        `☁️ <b>CONFIGURATION DU STOCKAGE CLOUD PERSISTANT</b>\n\n` +
        `• <b>Chat/Canal actuel :</b> <code>${current || 'Non configuré'}</code>\n\n` +
        `📝 <b>Utilisation :</b>\n` +
        `<code>/setstorage -100xxxxxxxxxx</code>\n\n` +
        `💡 <i>Ce canal sert de base de données Cloud : le bot y publie et épingle ses instantanés JSON. Au démarrage sur Render, il y télécharge automatiquement toutes vos données pour ne jamais rien perdre !</i>`,
        { parse_mode: 'HTML' }
      );
    }

    try {
      const chat = await ctx.api.getChat(cleanInput);
      if (!chat) {
        return ctx.reply(`❌ Impossible de trouver le chat "${cleanInput}".`);
      }

      db.setStorageChatId(chat.id);

      // Tester immédiatement l'envoi et l'épinglage d'un backup
      const res = await CloudSyncService.saveToCloud(ctx.api, 'manual_setup');
      if (res.success) {
        return ctx.reply(
          `✅ <b>Canal de stockage Cloud configuré et actif !</b> ☁️🎉\n\n` +
          `• <b>Titre :</b> ${escapeHtml(chat.title || cleanInput)}\n` +
          `• <b>ID :</b> <code>${chat.id}</code>\n\n` +
          `📦 <b>Instantané complet épinglé avec succès !</b>\n` +
          `🛡️ <i>Vos utilisateurs, séries et paramètres seront désormais automatiquement restaurés à chaque nouveau déploiement sur Render !</i>`,
          { parse_mode: 'HTML' }
        );
      } else {
        return ctx.reply(
          `⚠️ <b>Canal enregistré mais échec du test d'écriture :</b>\n\n` +
          `<code>${escapeHtml(res.error || res.reason)}</code>\n\n` +
          `👉 <i>Vérifiez que le bot est bien administrateur du canal avec le droit de publier et d'épingler des messages.</i>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      return ctx.reply(`❌ Erreur configuration stockage : ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  }

  /**
   * Force une synchronisation Cloud immédiate vers Telegram
   */
  static async syncCloudCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const res = await CloudSyncService.saveToCloud(ctx.api, 'admin_manual');
    if (res.success) {
      return ctx.reply(
        `☁️ <b>SYNCHRONISATION CLOUD RÉUSSIE !</b> 🚀\n\n` +
        `👥 Membres privés sauvegardés : <b>${res.meta.privateUsersCount}</b> (${res.meta.knownUsersCount} connus)\n` +
        `🎬 Séries sauvegardées : <b>${res.meta.showsCount}</b>\n` +
        `👑 Maîtres sauvegardés : <b>${res.meta.mastersCount}</b>\n` +
        `📌 Instantané épinglé dans : <code>${CloudSyncService.getStorageChatId()}</code>`,
        { parse_mode: 'HTML' }
      );
    } else {
      return ctx.reply(
        `❌ <b>Échec de la sauvegarde Cloud :</b>\n\n` +
        `<code>${escapeHtml(res.error || res.reason)}</code>\n\n` +
        `👉 <i>Définissez d'abord un canal avec <code>/setstorage [ID]</code> ou <code>/setaudit [ID]</code>.</i>`,
        { parse_mode: 'HTML' }
      );
    }
  }

  /**
   * Force une restauration immédiate depuis Telegram Cloud
   */
  static async restoreCloudCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const res = await CloudSyncService.hydrateFromCloud(ctx.api);
    if (res.success) {
      return ctx.reply(
        `🚀 <b>RESTAURATION CLOUD EFFECTUÉE AVEC SUCCÈS !</b>\n\n` +
        `👥 Membres privés restaurés : <b>${res.usersCount}</b>\n` +
        `🎬 Séries restaurées : <b>${res.showsCount}</b>\n\n` +
        `✅ <i>La base locale a été mise à jour depuis l'instantané Telegram Cloud !</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      return ctx.reply(
        `❌ <b>Impossible de restaurer depuis Telegram Cloud :</b>\n\n` +
        `<code>${escapeHtml(res.error || res.reason)}</code>`,
        { parse_mode: 'HTML' }
      );
    }
  }

  /**
   * Affiche l'état du système de persistance Cloud
   */
  static async storageStatusCommand(ctx) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return ctx.reply("⛔ Accès réservé aux administrateurs.");
    }

    const storageId = CloudSyncService.getStorageChatId();
    const privCount = db.getPrivateUsers().length;
    const knownCount = Object.keys(db.data.knownUsers || {}).length;
    const showsCount = db.getShowsList().length;

    let text =
      `☁️ <b>ÉTAT DU STOCKAGE PERSISTANT CLOUD</b>\n\n` +
      `📡 <b>Canal de persistance :</b> <code>${storageId || 'Non configuré'}</code>\n` +
      `👥 <b>Membres en mémoire :</b> <b>${privCount}</b> privés (<b>${knownCount}</b> connus)\n` +
      `📺 <b>Séries en mémoire :</b> <b>${showsCount}</b>\n` +
      `🕒 <b>Dernière synchronisation :</b> <code>${CloudSyncService.lastCloudSyncAt || 'En attente'}</code>\n\n` +
      `💡 <b>Commandes utiles :</b>\n` +
      `• <code>/synccloud</code> : Sauvegarder immédiatement sur le Cloud\n` +
      `• <code>/restorecloud</code> : Recharger manuellement depuis le Cloud\n` +
      `• <code>/setstorage [ID]</code> : Modifier le canal de stockage`;

    return ctx.reply(text, { parse_mode: 'HTML' });
  }

  /**
   * Discussion personnelle avec l'IA en privé (Assistant Community Manager Télé-Réalité)
   */
  static async handlePrivateChat(ctx, userMessage) {
    const userId = ctx.from?.id;
    if (!this.isAuthorized(ctx.from || userId)) {
      return;
    }

    const cleanMessage = (userMessage || '').trim();
    if (!cleanMessage) return;

    // Si l'administrateur demande une émission pour vérifier ou regarder
    const matchedShow = db.findShow(cleanMessage);
    if (matchedShow) {
      return ctx.reply(
        `🎬 <b>Fiche Émission (Mode Admin) :</b>\n\n` +
        `• Nom : <b>${escapeHtml(matchedShow.name)}</b>\n` +
        `• Lien direct : ${matchedShow.link}\n` +
        (matchedShow.description ? `• Description : <i>${escapeHtml(matchedShow.description)}</i>\n` : '') +
        `• ID interne : <code>${escapeHtml(matchedShow.id)}</code>`,
        { parse_mode: 'HTML' }
      );
    }

    const isMasterUser = db.isMaster(ctx.from);
    const authorName = isMasterUser ? 'Mon Maître' : (ctx.from?.first_name || 'Propriétaire');

    // Mémoriser le message utilisateur
    conversationSessions.addMessage(userId, 'user', cleanMessage);

    const privateAssistantPrompt = isMasterUser
      ? `
Tu es Léna (@Lenasituation_bot), l'animatrice et complice de ton MAÎTRE qui discute avec toi en message privé.
CONSIGNES STRICTES :
- Adresse-toi à lui en l'appelant "Maître" ou "Sa Majesté".
- RÈGLE STRICTE ANTI-PAVÉ : Réponds en 1 ou 2 phrases courtes maximum (25 mots max). INTERDICTION FORMELLE d'écrire un roman, un long paragraphe ou des flatteries grandiloquentes.
- EMOJIS : Maximum 1 seul emoji discret (ou aucun). Pas d'avalanche d'emojis.
- TON : Décontracté, cool, complice, direct et naturel.
- Suis le fil de la discussion avec intelligence.
`
      : `
Tu es Léna (@Lenasituation_bot), animatrice et assistante en Télé-Réalité en discussion privée avec ${authorName}.
CONSIGNES STRICTES :
- RÈGLE STRICTE ANTI-PAVÉ : 1 à 2 phrases courtes maximum (25 mots max).
- EMOJIS : Maximum 1 seul emoji discret (ou aucun).
- TON : Décontracté, cool, naturel et amical.
- Suis le fil de la discussion simplement.
`;

    const allowMimicry = conversationSessions.shouldAllowMimicry(userId, 12);

    try {
      const history = conversationSessions.getHistory(userId);
      let response = await geminiService.generateChatResponse(privateAssistantPrompt, history, 120, allowMimicry);
      if (response) {
        if (isMasterUser && !/\b(maître|maitre|sa majesté|sa majeste|seigneur)\b/i.test(response)) {
          response = `À vos ordres, Maître ! ✨ ${response}`;
        }
        conversationSessions.addMessage(userId, 'assistant', response);
        conversationSessions.recordTurn(userId, allowMimicry);
        await ctx.reply(response, { reply_to_message_id: ctx.message?.message_id });
        return;
      }
    } catch (err) {
      console.error('[PRIVATE ADMIN] Erreur IA assistant privé:', err);
    }

    const fallbackMsg = isMasterUser
      ? "À vos ordres, Maître ! Votre volonté est ma loi. Que désire Sa Majesté pour le canal ? 👑✨"
      : "Je suis là avec toi ! Dis-moi tout, de quoi avons-nous besoin pour le canal ? 🍿";
    await ctx.reply(fallbackMsg);
  }
}
