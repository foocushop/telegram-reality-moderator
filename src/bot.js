import http from 'node:http';
import { Bot } from 'grammy';
import { config } from './config.js';
import { db } from './storage/database.js';
import { Moderator } from './moderation/moderator.js';
import { ActionManager } from './moderation/actionManager.js';
import { escapeHtml } from './utils/format.js';
import { geminiService } from './ai/gemini.js';
import { resolveTarget } from './utils/resolver.js';
import { PrivateAdminManager } from './admin/privateAdmin.js';
import { MemberCatalogService } from './services/memberCatalogService.js';
import { CloudSyncService } from './services/cloudSyncService.js';
import { AuditRecoveryService } from './services/auditRecoveryService.js';

async function bootstrap() {
  console.log('====================================================');
  console.log('🚀 Démarrage du Bot Telegram Télé-Réalité Modérateur');
  console.log('====================================================');

  if (!config.telegramToken || config.telegramToken === 'VOTRE_TOKEN_TELEGRAM_ICI') {
    console.error('❌ ERREUR: Le TELEGRAM_BOT_TOKEN n\'est pas configuré dans le fichier .env !');
    console.error('👉 Veuillez éditer le fichier .env et y coller le token fourni par @BotFather.');
    process.exit(1);
  }

  const bot = new Bot(config.telegramToken);

  // Récupération des informations du bot (nom, username)
  let botInfo;
  try {
    botInfo = await bot.api.getMe();
    console.log(`🤖 Bot connecté avec succès sous le nom : @${botInfo.username} (${botInfo.first_name})`);
  } catch (err) {
    console.error('❌ Impossible de se connecter aux serveurs de Telegram avec ce token :', err.message);
    process.exit(1);
  }

  // --- Restauration Automatique Cloud Telegram (Indestructible face aux redéploiements Render) ---
  try {
    const syncRes = await CloudSyncService.hydrateFromCloud(bot.api);
    if (syncRes && syncRes.success) {
      console.log(`[BOOTSTRAP] ☁️ Persistance Cloud active : base rechargée automatiquement.`);
    }
  } catch (syncErr) {
    console.warn('[BOOTSTRAP] ⚠️ Impossible d\'exécuter l\'auto-hydration Cloud :', syncErr.message);
  }

  // --- Gestion globale des erreurs ---
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[ERREUR GRAMMY] Erreur lors du traitement de la mise à jour ${ctx.update?.update_id}:`);
    const e = err.error;
    console.error(e.message || e);
  });

  // --- Middleware de sécurité Administrateur ---
  const requireAdmin = async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const isImmune = await ActionManager.isImmune(ctx, userId);
    if (isImmune) {
      return next();
    }

    await ctx.reply("⛔ Vous n'avez pas les droits d'administration pour exécuter cette commande.");
  };

  // --- Gestion des Callbacks de boutons (Privé & Public) ---
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith('p_')) {
      await PrivateAdminManager.handleCallback(ctx, data);
    }
  });

  // --- Commandes Publiques & Membres ---

  // /start (Distinction automatique entre MP privé admin, MP privé membre et groupe public)
  bot.command('start', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      if (ctx.from) {
        db.savePrivateUser(ctx.from);
        CloudSyncService.triggerDebouncedSave(ctx.api, 30000, 'user_start');
      }
      if (PrivateAdminManager.isAuthorized(ctx.from || ctx.from?.id)) {
        return PrivateAdminManager.sendDashboard(ctx);
      }
      return MemberCatalogService.handlePrivateMessage(ctx, 'bonjour');
    }

    const name = escapeHtml(botInfo.first_name);
    const username = escapeHtml(botInfo.username);
    await ctx.reply(
      `👋 Bonjour ! Je suis <b>${name}</b>, le bot de modération intelligente et d'animation pour les fans de Télé-Réalité ! 📺✨\n\n` +
      `🛡️ <b>Mes missions de protection :</b>\n` +
      `• Supprimer et bannir instantanément tout contenu adulte (NSFW, pornographie) ou gore.\n` +
      `• Filtrer les arnaques, spams et liens d'invitation interdits.\n` +
      `• Stopper les raids et le flood (messages trop rapides).\n` +
      `• Muter temporairement les auteurs de vulgarités ou insultes.\n` +
      `• Désamorcer les clashs et tensions avec humour et bonne humeur.\n` +
      `• Répondre à vos questions sur l'émission et le groupe quand vous en avez besoin !\n\n` +
      `Tapez /rules pour voir les règles officielles du groupe.`,
      { parse_mode: 'HTML' }
    );
  });

  // /rules
  bot.command('rules', async (ctx) => {
    await ctx.reply(
      `📜 <b>RÈGLES DU GROUPE TÉLÉ-RÉALITÉ</b> 📜\n\n` +
      `1️⃣ <b>Zéro contenu adulte / NSFW</b> : L'envoi d'images de nudité, pornographie ou violence entraîne un BANNISSEMENT DÉFINITIF sans préavis.\n` +
      `2️⃣ <b>Respect mutuel</b> : On adore les clashs et les débats sur les candidats, mais AUCUNE insulte entre membres n'est tolérée.\n` +
      `3️⃣ <b>Pas de spam ni de flood</b> : N'inondez pas le canal de messages consécutifs.\n` +
      `4️⃣ <b>Pas de liens publicitaires ou d'invitation</b> externes.\n` +
      `5️⃣ <b>Sanctions graduées</b> :\n` +
      `   • 1er avertissement : Rappel à l'ordre\n` +
      `   • 2ème avertissement : Mise en sourdine (mute) 15 min\n` +
      `   • 3ème avertissement ou récidive grave : Bannissement définitif\n\n` +
      `Que les meilleurs débats commencent ! 🍿🎉`,
      { parse_mode: 'HTML' }
    );
  });

  // --- Commandes Privées Spécifiques au Propriétaire ---

  // /menu ou /panel en privé
  bot.command(['menu', 'panel'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.sendDashboard(ctx);
    }
  });

  // /context en privé
  bot.command('context', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.handleCallback(ctx, 'p_context');
    }
  });

  // /setcontext en privé
  bot.command('setcontext', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const text = ctx.message.text.split(/\s+/).slice(1).join(' ');
      return PrivateAdminManager.updateContext(ctx, text, false);
    }
  });

  // /addcontext en privé
  bot.command('addcontext', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const text = ctx.message.text.split(/\s+/).slice(1).join(' ');
      return PrivateAdminManager.updateContext(ctx, text, true);
    }
  });

  // /broadcast ou /annonce pour diffuser sur tous les canaux et groupes depuis le privé
  bot.command(['broadcast', 'annonce'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const text = ctx.message.text.replace(/^\/(broadcast|annonce)\s*/i, '').trim();
      return PrivateAdminManager.broadcastToAll(ctx, text);
    }
  });

  // /broadcast_users, /broadcast_members ou /dm_all pour diffuser à tous les utilisateurs privés du bot
  bot.command(['broadcast_users', 'broadcast_members', 'dm_all'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const text = ctx.message.text.replace(/^\/(broadcast_users|broadcast_members|dm_all)\s*/i, '').trim();
      return PrivateAdminManager.broadcastToUsers(ctx, text);
    }
  });

  // /sync_users ou /syncusers pour synchroniser manuellement les utilisateurs connus vers la liste d'envoi privé
  bot.command(['sync_users', 'syncusers'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.syncUsersCommand(ctx);
    }
  });

  // /send, /dm ou /msg pour envoyer un message ciblé à un membre précis par son @username ou ID
  bot.command(['send', 'dm', 'msg'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const args = ctx.message.text.replace(/^\/(send|dm|msg)\s*/i, '').trim();
      return PrivateAdminManager.sendDirectMessage(ctx, args);
    }
  });

  // /channels ou /canaux pour gérer la liste des canaux et groupes de diffusion
  bot.command(['channels', 'canaux'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.sendChannelsList(ctx);
    }
  });

  // /addchannel ou /addcanal pour ajouter manuellement un canal
  bot.command(['addchannel', 'addcanal'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const args = ctx.message.text.replace(/^\/(addchannel|addcanal)\s*/i, '').trim();
      return PrivateAdminManager.addChannelManually(ctx, args);
    }
  });

  // /delchannel ou /delcanal pour retirer un canal
  bot.command(['delchannel', 'delcanal'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const args = ctx.message.text.replace(/^\/(delchannel|delcanal)\s*/i, '').trim();
      return PrivateAdminManager.removeChannelManually(ctx, args);
    }
  });

  // /setaudit ou /audit_channel pour configurer le canal d'audit dédié
  bot.command(['setaudit', 'audit_channel', 'set_audit'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const args = ctx.message.text.replace(/^\/(setaudit|audit_channel|set_audit)\s*/i, '').trim();
      return PrivateAdminManager.setAuditChannelCommand(ctx, args);
    }
  });

  // /testaudit pour tester l'envoi d'un message dans le canal d'audit
  bot.command('testaudit', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.testAuditChannelCommand(ctx);
    }
  });

  // /unsetaudit pour désactiver le relais d'audit Telegram
  bot.command('unsetaudit', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.unsetAuditChannelCommand(ctx);
    }
  });

  // /setstorage ou /setbackup pour configurer le canal de stockage persistant Cloud
  bot.command(['setstorage', 'setbackup'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const args = ctx.message.text.replace(/^\/(setstorage|setbackup)\s*/i, '').trim();
      return PrivateAdminManager.setStorageCommand(ctx, args);
    }
  });

  // /synccloud ou /cloudsync pour forcer une sauvegarde Cloud immédiate
  bot.command(['synccloud', 'cloudsync'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.syncCloudCommand(ctx);
    }
  });

  // /restorecloud pour restaurer immédiatement depuis Telegram Cloud
  bot.command('restorecloud', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.restoreCloudCommand(ctx);
    }
  });

  // /storage pour afficher le statut du stockage persistant
  bot.command('storage', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.storageStatusCommand(ctx);
    }
  });

  // /recover_users ou /recupusers pour récupérer les membres depuis l'audit
  bot.command(['recover_users', 'recoverusers', 'recupusers', 'recup_membres'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const args = ctx.message.text.replace(/^\/(recover_users|recoverusers|recupusers|recup_membres)\s*/i, '').trim();
      if (args) {
        const found = AuditRecoveryService.parseUsers(args);
        if (found.length > 0) {
          const res = await AuditRecoveryService.injectRecoveredUsers(found, ctx.api);
          return ctx.reply(
            `🎉 <b>RÉCUPÉRATION EFFECTUÉE !</b> 👥\n\n` +
            `📥 <b>${res.injectedCount}</b> membre(s) historique(s) identifié(s) et injecté(s) dans la base.\n` +
            `📈 <b>Total membres privés :</b> <b>${res.totalUsers}</b>\n` +
            `☁️ <i>Sauvegarde Cloud mise à jour et automatiquement épinglée !</i>`,
            { parse_mode: 'HTML' }
          );
        }
      }
      return PrivateAdminManager.recoverAuditUsersCommand(ctx);
    }
  });

  // /bans en privé
  bot.command('bans', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.handleCallback(ctx, 'p_bans');
    }
  });

  // /mutes en privé
  bot.command('mutes', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.handleCallback(ctx, 'p_mutes');
    }
  });

  // /claim pour s'attribuer le statut de propriétaire en privé
  bot.command('claim', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const userId = ctx.from?.id;
      db.setOwnerId(userId);
      await ctx.reply(
        `👑 <b>Propriété du bot confirmée !</b>\n\n` +
        `Votre compte (ID: <code>${userId}</code>) est désormais enregistré comme Propriétaire Principal.\n` +
        `Tapez /menu pour ouvrir votre salle de contrôle.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // /setmaster ou /master pour définir le Maître Suprême
  bot.command(['setmaster', 'master'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(setmaster|master)\s*/i, '').trim();
    return PrivateAdminManager.setMasterCommand(ctx, args);
  });

  // /masters ou /maitres pour lister les Maîtres
  bot.command(['masters', 'maitres'], async (ctx) => {
    return PrivateAdminManager.listMastersCommand(ctx);
  });

  // /addmaster pour ajouter un Maître
  bot.command('addmaster', async (ctx) => {
    const args = ctx.message.text.replace(/^\/addmaster\s*/i, '').trim();
    return PrivateAdminManager.addMasterCommand(ctx, args);
  });

  // /delmaster ou /removemaster pour retirer un Maître
  bot.command(['delmaster', 'removemaster', 'delmaitre', 'removemaitre'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(delmaster|removemaster|delmaitre|removemaitre)\s*/i, '').trim();
    return PrivateAdminManager.delMasterCommand(ctx, args);
  });

  // /addshow pour ajouter une émission
  bot.command('addshow', async (ctx) => {
    const args = ctx.message.text.replace(/^\/addshow\s*/i, '').trim();
    return PrivateAdminManager.addShowCommand(ctx, args);
  });

  // /delshow pour supprimer une émission
  bot.command('delshow', async (ctx) => {
    const args = ctx.message.text.replace(/^\/delshow\s*/i, '').trim();
    return PrivateAdminManager.delShowCommand(ctx, args);
  });

  // /backup pour créer une sauvegarde locale
  bot.command('backup', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.handleBackup(ctx);
    }
  });

  // /export ou /exportshows pour exporter le catalogue JSON directement dans Telegram
  bot.command(['export', 'exportshows'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.exportShowsCommand(ctx);
    }
  });

  // /backups pour lister les sauvegardes
  bot.command('backups', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.listBackupsCommand(ctx);
    }
  });

  // /restoreshows pour forcer la restauration
  bot.command('restoreshows', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.restoreShowsCommand(ctx);
    }
  });

  // /shows et /series (catalogue complet admin ou membre)
  bot.command(['shows', 'series'], async (ctx) => {
    if (PrivateAdminManager.isAuthorized(ctx.from || ctx.from?.id)) {
      return PrivateAdminManager.listShowsCommand(ctx);
    }
    return ctx.reply(MemberCatalogService.getCatalogMessage(), { parse_mode: 'HTML' });
  });

  // /liste et /catalogue pour les membres
  bot.command(['liste', 'catalogue'], async (ctx) => {
    return ctx.reply(MemberCatalogService.getCatalogMessage(), { parse_mode: 'HTML' });
  });

  // --- Commandes Administrateur Générales (Groupe & Privé) ---

  // /admin ou /adminhelp : Dashboard
  const showAdminHelp = async (ctx) => {
    if (ctx.chat?.type === 'private') {
      return PrivateAdminManager.sendDashboard(ctx);
    }

    await ctx.reply(
      `👑 <b>PANNEAU DE CONTRÔLE ADMINISTRATEUR</b>\n\n` +
      `📊 <b>Statistiques & Surveillance :</b>\n` +
      `• <code>/stats</code> : Statistiques complètes de modération\n` +
      `• <code>/reload</code> : Synchroniser à chaud <code>context.txt</code> et rafraîchir les admins\n\n` +
      `⚡ <b>Sanctions rapides (par réponse ou @pseudo) :</b>\n` +
      `• <code>/warn [@pseudo] [motif]</code> : Avertissement (1=Rappel, 2=Mute, 3=Ban)\n` +
      `• <code>/warnings [@pseudo]</code> : Voir le casier d'un membre\n` +
      `• <code>/unwarn [@pseudo]</code> : Réinitialiser les avertissements\n` +
      `• <code>/mute [@pseudo] [minutes] [motif]</code> : Mise en sourdine temporaire\n` +
      `• <code>/unmute [@pseudo]</code> : Rétablir la parole d'un membre muté\n` +
      `• <code>/ban [@pseudo] [motif]</code> : Bannissement définitif immédiat\n` +
      `• <code>/unban [@pseudo ou ID]</code> : Débannir un membre\n\n` +
      `🛡️ <b>Gestion de crise & Anti-Raid :</b>\n` +
      `• <code>/slowmode [secondes]</code> : Ralentir le chat (ex: <code>/slowmode 15</code> ou <code>0</code>)\n` +
      `• <code>/lockdown</code> : Verrouiller le groupe d'urgence (seuls les admins parlent)\n` +
      `• <code>/unlock</code> : Déverrouiller le groupe et rouvrir le chat\n\n` +
      `💡 <i>Astuce : Vous pouvez aussi parler en privé au bot pour tout gérer depuis votre lit !</i>`,
      { parse_mode: 'HTML' }
    );
  };

  bot.command('admin', requireAdmin, showAdminHelp);
  bot.command('adminhelp', requireAdmin, showAdminHelp);

  // /stats
  bot.command('stats', requireAdmin, async (ctx) => {
    const stats = db.getStats();
    await ctx.reply(
      `📊 <b>STATISTIQUES DE MODÉRATION</b>\n\n` +
      `💬 Messages analysés : <b>${stats.messagesScanned}</b>\n` +
      `📸 Images inspectées par l'IA : <b>${stats.imagesScanned}</b>\n` +
      `🚫 Total des bannissements : <b>${stats.bansCount}</b>\n` +
      `⏳ Total des mises en sourdine (mutes) : <b>${stats.mutesCount}</b>\n` +
      `🌊 Floods stoppés : <b>${stats.floodIntercepted || 0}</b>\n` +
      `🔗 Liens / pubs bloqués : <b>${stats.linksBlocked || 0}</b>\n` +
      `🔒 Bannis actifs en base : <b>${stats.activeBans}</b>\n` +
      `🔇 Mutes actifs en base : <b>${stats.activeMutes}</b>\n` +
      `🤖 Moteur IA actif : <b>${escapeHtml(geminiService.getActiveModelName())}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  // /warn
  bot.command('warn', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'warn');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }
    await ActionManager.executeWarn(ctx, target.userId, target.userDetails, target.reason);
  });

  // /warnings
  bot.command('warnings', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'warnings');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }
    const list = db.getWarnings(target.userId);
    const rawTarget = target.userDetails?.username ? `@${target.userDetails.username}` : (target.userDetails?.fullName || `ID:${target.userId}`);
    const targetName = escapeHtml(rawTarget);

    if (list.length === 0) {
      return ctx.reply(`✅ Le membre <b>${targetName}</b> n'a aucun avertissement à son actif.`, { parse_mode: 'HTML' });
    }

    let msg = `⚠️ <b>CASIER DE ${targetName} (${list.length}/3)</b>\n\n`;
    list.forEach((w, idx) => {
      msg += `${idx + 1}. <i>${escapeHtml(w.reason)}</i> (par ${escapeHtml(w.by)})\n`;
    });
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /unwarn
  bot.command('unwarn', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'unwarn');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }
    db.clearWarnings(target.userId);
    const rawTarget = target.userDetails?.username ? `@${target.userDetails.username}` : (target.userDetails?.fullName || `ID:${target.userId}`);
    await ctx.reply(`✅ Les avertissements de <b>${escapeHtml(rawTarget)}</b> ont été réinitialisés à zéro.`, { parse_mode: 'HTML' });
  });

  // /slowmode
  bot.command('slowmode', requireAdmin, async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const sec = parseInt(args[0] || '0', 10);

    const success = await ActionManager.setSlowMode(ctx, sec);
    if (success) {
      if (sec > 0) {
        await ctx.reply(`⏱️ <b>SLOWMODE ACTIVÉ</b> : Les membres doivent patienter <b>${sec} secondes</b> entre chaque message.`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⏱️ <b>SLOWMODE DÉSACTIVÉ</b> : Discussion en temps réel rétablie.`, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(`❌ Impossible de configurer le slowmode.`);
    }
  });

  // /lockdown
  bot.command('lockdown', requireAdmin, async (ctx) => {
    const success = await ActionManager.setLockdown(ctx, true);
    if (success) {
      await ctx.reply(
        `🔒 <b>GROUPE VERROUILLÉ EN URGENCE</b>\n\n` +
        `L'envoi de messages est temporairement suspendu pour les membres le temps de maîtriser la situation.\n` +
        `<i>Seuls les administrateurs peuvent communiquer pour le moment.</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(`❌ Échec du verrouillage.`);
    }
  });

  // /unlock
  bot.command('unlock', requireAdmin, async (ctx) => {
    const success = await ActionManager.setLockdown(ctx, false);
    if (success) {
      await ctx.reply(
        `🔓 <b>GROUPE DÉVERROUILLÉ</b>\n\n` +
        `Le calme est rétabli ! Vous pouvez de nouveau échanger. Merci à tous pour votre compréhension ! 🍿✨`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(`❌ Échec du déverrouillage.`);
    }
  });

  // /reload
  bot.command('reload', requireAdmin, async (ctx) => {
    await ActionManager.refreshAdmins(ctx);
    await ctx.reply(
      `🔄 <b>SYNCHRONISATION EFFECTUÉE AVEC SUCCÈS !</b>\n\n` +
      `• Le fichier <code>context.txt</code> a été rechargé.\n` +
      `• La liste des administrateurs et du propriétaire a été mise à jour.\n` +
      `• Le bot est opérationnel avec vos dernières instructions ! 🚀`,
      { parse_mode: 'HTML' }
    );
  });

  // /ban
  bot.command('ban', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'ban');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }
    await ActionManager.executeBan(ctx, target.userId, target.userDetails, target.reason);
  });

  // /mute
  bot.command('mute', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'mute');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }
    await ActionManager.executeMute(ctx, target.userId, target.userDetails, target.reason, target.minutes);
  });

  // /unban
  bot.command('unban', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'unban');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }

    const success = await ActionManager.executeUnban(ctx, target.userId);
    const targetLabel = target.userDetails?.username ? `@${target.userDetails.username}` : (target.userDetails?.fullName || `ID:${target.userId}`);
    if (success) {
      await ctx.reply(`✅ L'utilisateur <b>${escapeHtml(targetLabel)}</b> a été débanni.`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`❌ Impossible de débannir <b>${escapeHtml(targetLabel)}</b>.`, { parse_mode: 'HTML' });
    }
  });

  // /unmute
  bot.command('unmute', requireAdmin, async (ctx) => {
    const target = resolveTarget(ctx, 'unmute');
    if (target.error) {
      return ctx.reply(target.error, { parse_mode: 'HTML' });
    }

    const success = await ActionManager.executeUnmute(ctx, target.userId);
    const targetLabel = target.userDetails?.username ? `@${target.userDetails.username}` : (target.userDetails?.fullName || `ID:${target.userId}`);
    if (success) {
      await ctx.reply(`✅ L'utilisateur <b>${escapeHtml(targetLabel)}</b> peut de nouveau parler.`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`❌ Impossible de dé-muter <b>${escapeHtml(targetLabel)}</b>.`, { parse_mode: 'HTML' });
    }
  });

  // --- Nouveaux Membres ---
  bot.on('message:new_chat_members', async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    for (const member of newMembers) {
      if (member.is_bot) continue;

      db.saveUser(member.id, {
        username: member.username,
        fullName: [member.first_name, member.last_name].filter(Boolean).join(' ')
      });

      if (db.isUserBanned(member.id)) {
        console.log(`[ANTI-EVASION] 🚨 Récidiviste repéré lors de son entrée : ${member.id}`);
        await ActionManager.executeBan(ctx, member.id, {
          username: member.username,
          fullName: member.first_name
        }, "Tentative de retour suite à un bannissement.");
        continue;
      }

      if (config.welcomeNewMembers) {
        const welcomeName = escapeHtml(member.first_name || 'Fan');
        await ctx.reply(
          `👋 Bienvenue dans le groupe <b>${welcomeName}</b> ! 📺🍿\n` +
          `Installe-toi confortablement pour débriefer les émissions. Pense à jeter un œil aux /rules pour une super ambiance !`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }
  });

  // --- Détection automatique de l'ajout/retrait du bot dans un canal ou groupe ---
  bot.on('my_chat_member', async (ctx) => {
    try {
      const chat = ctx.chat;
      const newStatus = ctx.myChatMember?.new_chat_member?.status;
      const oldStatus = ctx.myChatMember?.old_chat_member?.status;

      console.log(`[MY_CHAT_MEMBER] Chat: "${chat.title}" (${chat.id}, type: ${chat.type}) | Statut: ${oldStatus} -> ${newStatus}`);

      if (['administrator', 'creator'].includes(newStatus)) {
        db.addManagedChat(chat.id, chat.title, chat.type, chat.username);
        console.log(`[MY_CHAT_MEMBER] ✅ Bot configuré comme admin dans : "${chat.title}" (${chat.id})`);
      } else if (['left', 'kicked'].includes(newStatus)) {
        db.removeManagedChat(chat.id);
        console.log(`[MY_CHAT_MEMBER] ⚠️ Bot retiré de : "${chat.title}" (${chat.id})`);
      }
    } catch (err) {
      console.error('[MY_CHAT_MEMBER] Erreur traitement mise à jour :', err);
    }
  });

  // --- Enregistrement automatique des canaux lors de la publication de messages ---
  bot.on('channel_post', async (ctx) => {
    try {
      const chat = ctx.channelPost?.chat || ctx.chat;
      if (chat && chat.id) {
        db.addManagedChat(chat.id, chat.title, chat.type || 'channel', chat.username);
      }
    } catch (err) {
      console.error('[CHANNEL_POST] Erreur enregistrement canal :', err);
    }
  });

  // --- Router Principal de tous les messages ---
  bot.on('message', async (ctx) => {
    const text = ctx.message.text || '';

    // Si c'est en chat privé avec le bot
    if (ctx.chat?.type === 'private') {
      // Enregistrer systématiquement l'utilisateur privé
      if (ctx.from) {
        db.savePrivateUser(ctx.from);
        CloudSyncService.triggerDebouncedSave(ctx.api, 30000, 'private_user_activity');
      }

      // Si l'administrateur envoie un document (JSON, TXT, HTML, LOG)
      if (ctx.message?.document) {
        if (PrivateAdminManager.isAuthorized(ctx.from || ctx.from?.id)) {
          return PrivateAdminManager.handleFileImport(ctx);
        }
      }

      // Détection automatique lors d'un transfert de message depuis un canal
      const forwardedChat = ctx.message.forward_from_chat;
      if (forwardedChat && forwardedChat.type === 'channel') {
        if (PrivateAdminManager.isAuthorized(ctx.from || ctx.from?.id)) {
          // Vérifier d'abord si c'est un message d'audit transféré
          const recovered = AuditRecoveryService.parseUsers(text);
          if (recovered.length > 0) {
            const injectRes = await AuditRecoveryService.injectRecoveredUsers(recovered, ctx.api);
            return ctx.reply(
              `📥 <b>Membres d'audit récupérés !</b> 👥\n\n` +
              `• <b>${recovered.length}</b> utilisateur(s) extrait(s) de ce transfert.\n` +
              `• 📈 Total membres privés enregistrés : <b>${injectRes.totalUsers}</b>\n` +
              `• ☁️ Sauvegarde Cloud actualisée et épinglée.`,
              { parse_mode: 'HTML' }
            );
          }
          return PrivateAdminManager.addChannelManually(ctx, String(forwardedChat.id));
        }
      }

      // Détection de logs d'audit collés directement en texte
      if (PrivateAdminManager.isAuthorized(ctx.from || ctx.from?.id) && !text.startsWith('/')) {
        const recoveredFromText = AuditRecoveryService.parseUsers(text);
        if (recoveredFromText.length > 0 && (text.includes('AUDIT') || text.includes('Membre :') || text.includes('[ID:'))) {
          const injectRes = await AuditRecoveryService.injectRecoveredUsers(recoveredFromText, ctx.api);
          return ctx.reply(
            `🎉 <b>RÉCUPÉRATION EFFECTUÉE !</b> 👥\n\n` +
            `📥 <b>${recoveredFromText.length}</b> membre(s) historique(s) extrait(s) et injecté(s) dans la base.\n` +
            `📈 <b>Total membres privés :</b> <b>${injectRes.totalUsers}</b>\n` +
            `☁️ <i>Nouvelle sauvegarde Cloud générée et automatiquement épinglée dans votre canal de persistance !</i>`,
            { parse_mode: 'HTML' }
          );
        }
      }

      if (!text.startsWith('/')) {
        if (PrivateAdminManager.isAuthorized(ctx.from || ctx.from?.id)) {
          await PrivateAdminManager.handlePrivateChat(ctx, text);
        } else {
          await MemberCatalogService.handlePrivateMessage(ctx, text);
        }
      }
      return;
    }

    // Si c'est dans un groupe Telegram
    db.setMainGroupId(ctx.chat.id, ctx.chat.title, ctx.chat.type, ctx.chat.username);

    // Si c'est une commande déjà gérée
    if (text.startsWith('/')) {
      return;
    }

    await Moderator.processMessage(ctx, botInfo.username);
  });

  // Gestionnaires de sécurité pour éviter tout crash inopiné du processus
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROCESS] Rejet non géré intercepté :', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[PROCESS] Exception non capturée interceptée :', err);
  });

  // Serveur HTTP de santé / Healthcheck (requis pour Render et pings)
  const port = process.env.PORT || 7860;
  let totalPingsReceived = 0;
  const server = http.createServer((req, res) => {
    totalPingsReceived++;
    const now = new Date().toLocaleTimeString('fr-FR');
    console.log(`[HTTP SERVEUR] 📥 [${now}] Signal d'activité reçu #${totalPingsReceived} (${req.method} ${req.url}) -> Compteur Render remis à zéro !`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      bot: botInfo?.username || 'Lenasituation_bot',
      managedChats: db.getManagedChats().length,
      pingsReceived: totalPingsReceived,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    }));
  });
  server.listen(port, () => {
    console.log(`🌐 Serveur HTTP actif sur le port ${port} (prêt à recevoir les auto-pings Render)`);
  });

  // Système d'auto-maintien éveillé intégré (Self-Ping automatique pour Render)
  // Évite STRICTEMENT d'avoir à configurer un cron job externe !
  const renderExternalUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL;
  if (renderExternalUrl) {
    let pingCount = 0;
    console.log(`[SELF-PING] ⏰ Maintien automatique activé sur : ${renderExternalUrl}`);
    console.log(`[SELF-PING] 🚀 Premier test de signal de vie dans 30 secondes (pour vérifier le bon fonctionnement)...`);

    const sendPing = async () => {
      pingCount++;
      const startTime = Date.now();
      const timeStr = new Date().toLocaleTimeString('fr-FR');
      try {
        const pingRes = await fetch(renderExternalUrl);
        const duration = Date.now() - startTime;
        if (pingRes.ok) {
          console.log(`[SELF-PING] 💓 [${timeStr}] Signal #${pingCount} envoyé avec succès (${renderExternalUrl}) [${duration}ms] -> Bot maintenu éveillé 24h/24 !`);
        } else {
          console.warn(`[SELF-PING] ⚠️ [${timeStr}] Signal #${pingCount} : Statut HTTP ${pingRes.status} reçu de Render.`);
        }
      } catch (err) {
        console.error(`[SELF-PING] ⚠️ [${timeStr}] Échec temporaire du ping :`, err.message);
      }
    };

    // 1. Premier ping rapide après 30 secondes pour que vous le voyiez immédiatement dans la console
    setTimeout(sendPing, 30 * 1000);

    // 2. Puis toutes les 9 minutes en continu
    setInterval(sendPing, 9 * 60 * 1000);
  }

  // Démarrage du bot avec écoute continue (long-polling) et support explicite des canaux
  console.log('✅ Le bot écoute activement les messages Telegram...');
  bot.start({
    allowed_updates: [
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post',
      'my_chat_member',
      'chat_member',
      'callback_query'
    ],
    onStart: () => {
      console.log('📡 Service de modération, sécurité et diffusion multi-canaux actif 24h/24 !');
    }
  });
}

bootstrap().catch((err) => {
  console.error('❌ Erreur fatale lors du lancement du bot :', err);
});
