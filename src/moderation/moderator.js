import { config } from '../config.js';
import { db } from '../storage/database.js';
import { evaluateLocalTextRules } from './rules.js';
import { ActionManager } from './actionManager.js';
import { ImageScanner } from './imageScanner.js';
import { FloodProtector } from './floodProtector.js';
import { LinkProtector } from './linkProtector.js';
import { geminiService } from '../ai/gemini.js';
import { escapeHtml } from '../utils/format.js';
import { conversationSessions } from '../ai/conversationSession.js';

export function isModerationCommandPhrase(text, isReply = false) {
  if (!text) return false;
  const clean = text.toLowerCase().trim();

  // En réponse à un message d'un membre
  if (isReply) {
    if (/\b(bannir|bannis|banni|ban|vire|virer|dégage|degage|exclure|exclus|ejecte|éjecte|mute|muter|fais[ -]?le taire|silence)\b/i.test(clean)) {
      return true;
    }
  }

  // Si la phrase formule un ordre direct
  if (/^(tu peux|peux[- ]tu|merci de|faut|il faut|stp|svp)?\s*(bannir|bannis|banni|ban|vire|virer|dégage|degage|exclure|exclus|ejecte|éjecte|mute|muter|fais[ -]?le taire)\b/i.test(clean)) {
    return true;
  }

  if (/\b(bannir|bannis|banni|ban|vire|virer|mute|muter)\s+(celui[- ]ci|celui[- ]là|ce mec|cette fille|ce membre|ce compte|ce troll|le|la|les|@\w+)\b/i.test(clean)) {
    return true;
  }

  return false;
}

export class Moderator {
  static recentMessages = [];
  static lastInterventionTime = 0;
  static messagesSinceLastIntervention = 0;
  static lastMasterAlertTime = 0;

  /**
   * Enregistre un message dans l'historique récent du groupe (jusqu'à 30 messages)
   */
  static addRecentMessage(userName, text, isBot = false) {
    if (!text || typeof text !== 'string') return;
    const cleanText = text.trim();
    if (!cleanText) return;

    this.recentMessages.push({
      userName: userName || (isBot ? 'Léna (Modératrice)' : 'Membre'),
      text: cleanText,
      isBot: Boolean(isBot),
      timestamp: Date.now()
    });

    if (this.recentMessages.length > 30) {
      this.recentMessages.shift();
    }
  }

  /**
   * Récupère les derniers messages du groupe pour analyse contextuelle
   */
  static getRecentMessages(limit = 20) {
    return this.recentMessages.slice(-limit);
  }

  /**
   * Pipeline principal de modération appliqué à chaque message reçu
   * @param {import('grammy').Context} ctx 
   * @param {string} botUsername 
   */
  static async processMessage(ctx, botUsername) {
    const message = ctx.message;
    if (!message || !ctx.from) return;

    const user = ctx.from;
    const userId = user.id;
    const userDetails = {
      username: user.username,
      fullName: [user.first_name, user.last_name].filter(Boolean).join(' ')
    };

    // Mémoriser l'utilisateur pour permettre la modération par @username
    db.saveUser(userId, userDetails);

    // Vérifier l'immunité (Créateur ou Administrateur du groupe Telegram)
    const isImmune = await ActionManager.isImmune(ctx, userId);

    // 0. ANALYSE PRIORITAIRE DES IMAGES / PHOTOS (Détection NSFW, Nudité, Violence)
    // S'exécute pour tout média avec logs détaillés sur la console et protection des admins
    const imageResult = await ImageScanner.scanMessage(ctx, isImmune);
    if (imageResult.handled) {
      return;
    }

    // Récupération du texte (message textuel ou légende de photo)
    const text = message.text || message.caption || '';
    if (text) {
      const senderTag = userDetails.username ? `@${userDetails.username}` : (userDetails.fullName || `ID:${userId}`);
      console.log(`[GROUPE] 💬 Message de ${senderTag} (${isImmune ? '🛡️ Admin/Immunisé' : '👤 Membre'}) : "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);
    }

    // Si l'utilisateur est un membre standard (non-admin), on applique la modération stricte
    if (!isImmune) {
      // 1. PROTECTION ANTI-FLOOD (Spam ultra rapide)
      const floodStatus = FloodProtector.checkFlood(userId);
      if (floodStatus.isFlooding) {
        console.log(`[MODERATION] 🚨 Flood détecté de l'utilisateur ${userId} (${floodStatus.count} msgs)`);
        db.incrementFloodCount();
        if (config.deleteOffendingMessages) {
          await ctx.deleteMessage().catch(() => {});
        }
        await ActionManager.executeMute(ctx, userId, userDetails, "Flood répété (envoi trop rapide de messages)", 5);
        return;
      }

      // 2. VÉRIFICATION ANTI-RÉCIDIVE (Ban Evasion)
      if (db.isUserBanned(userId)) {
        console.log(`[MODERATION] 🚨 Tentative de retour d'un utilisateur déjà banni : ${userId}`);
        await ActionManager.executeBan(ctx, userId, userDetails, "Tentative de retour après un bannissement antérieur.");
        return;
      }

      // 3. VÉRIFICATION DU STATUT MUTE (Mise en sourdine active)
      if (db.isUserMuted(userId)) {
        console.log(`[MODERATION] 🔇 Message intercepté d'un utilisateur muté : ${userId}`);
        if (config.deleteOffendingMessages) {
          await ctx.deleteMessage().catch(() => {});
        }
        return;
      }

      // 4. RÉCUPÉRATION DU TEXTE (Texte standard ou légende de média)
      if (!text) return;

      db.incrementMessageCount();

      // 5.1. PROTECTION ANTI-PUB & LIENS FRAUDULEUX
      const linkCheck = LinkProtector.checkLinks(text, botUsername);
      if (linkCheck.isBlocked) {
        console.log(`[MODERATION] 🚫 Lien bloqué pour ${userId} : ${linkCheck.reason}`);
        db.incrementLinkBlockedCount();
        if (config.deleteOffendingMessages) {
          await ctx.deleteMessage().catch(() => {});
        }
        const targetLabel = escapeHtml(userDetails.username ? `@${userDetails.username}` : (userDetails.fullName || `ID:${userId}`));
        await ctx.reply(
          `⚠️ <b>ANTI-PUB / LIEN SUSPECT INTERDIT</b>\n\n` +
          `👤 Membre : ${targetLabel}\n` +
          `🚫 Motif : ${escapeHtml(linkCheck.reason)}\n\n` +
          `<i>Les liens d'invitation externes, promotions et spams ne sont pas tolérés.</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }

      // 5.2. FILTRAGE RAPIDE LOCAL (0ms, 0 coût API)
      const localVerdict = evaluateLocalTextRules(text);
      if (localVerdict) {
        if (localVerdict.action === 'ban') {
          await ActionManager.executeBan(ctx, userId, userDetails, localVerdict.reason);
          return;
        }
        if (localVerdict.action === 'mute') {
          await ActionManager.executeMute(ctx, userId, userDetails, localVerdict.reason, config.muteDurationMinutes);
          return;
        }
      }

      // 5.3. ANALYSE SÉMANTIQUE IA (Pour propos insidieux ou ambigus, hors demandes d'émissions)
      if (geminiService.isConfigured && text.split(/\s+/).length >= 3 && !this.detectShowOrLinkRequest(text).isRequest) {
        const aiVerdict = await geminiService.analyzeText(text);
        if (aiVerdict.isViolation) {
          if (aiVerdict.action === 'ban') {
            await ActionManager.executeBan(ctx, userId, userDetails, aiVerdict.reason);
            return;
          }
          if (aiVerdict.action === 'mute') {
            await ActionManager.executeMute(ctx, userId, userDetails, aiVerdict.reason, config.muteDurationMinutes);
            return;
          }
        }
      }
    } else {
      // L'utilisateur est admin ou propriétaire : immunité totale de sanction
      db.incrementMessageCount();
    }

    // 6. RÉPONSE INTELLIGENTE ET CONTEXTUELLE (Accessible aux membres ET aux admins)
    if (text) {
      const authorName = userDetails.fullName || (userDetails.username ? `@${userDetails.username}` : 'Membre');
      this.addRecentMessage(authorName, text, false);

      const isReply = Boolean(message.reply_to_message && message.reply_to_message.from);
      const isModOrder = isModerationCommandPhrase(text, isReply);

      // 0. Si le message exprime un ordre de modération
      if (isModOrder) {
        if (db.isMaster(user)) {
          const orderHandled = await this.handleMasterNaturalOrder(ctx, text, botUsername, userDetails);
          if (orderHandled) return;
        } else {
          // Si un utilisateur non-maître essaie de donner un ordre de ban/mute
          const blocked = await this.handleNonMasterOrderAttempt(ctx, text, botUsername, userDetails);
          if (blocked) return;
        }
      }

      await this.handleSmartReply(ctx, text, botUsername, userDetails);
    }
  }

  /**
   * Intercepte et exécute les ordres de modération en langage naturel du MAÎTRE SUPRÊME
   * (ex: "Tu peux bannir celui-là", "Bannis-le", "Mute-le 15 minutes", "Vire-le", etc.)
   */
  static async handleMasterNaturalOrder(ctx, text, botUsername, userDetails) {
    const message = ctx.message;
    if (!message) return false;

    const lower = text.toLowerCase().trim();

    const isBanOrder = /\b(bannir|bannis|banni|ban|vire|virer|dégage|degage|degager|dégager|exclure|exclus|ejecte|éjecte)\b/i.test(lower);
    const isMuteOrder = /\b(mute|muter|mutez|fais[ -]?le taire|fais[ -]?la taire|silence|taire)\b/i.test(lower);
    const isUnbanOrder = /\b(débannir|debannir|débannis|debannis|déban|deban|gracie|gracier|pardonne|pardonner)\b/i.test(lower);
    const isUnmuteOrder = /\b(démute|demute|démuter|demuter|redonne[ -]?lui la parole|retire le mute)\b/i.test(lower);

    if (!isBanOrder && !isMuteOrder && !isUnbanOrder && !isUnmuteOrder) {
      return false;
    }

    console.log(`[MASTER COMMAND] 👑 Ordre naturel détecté de la part du Maître (${userDetails.username || userDetails.fullName}) : "${text}"`);

    // 1. Résolution de la cible
    let targetUserId = null;
    let targetDetails = null;

    // A. Cible par réponse directe (reply)
    if (message.reply_to_message && message.reply_to_message.from) {
      const targetUser = message.reply_to_message.from;
      targetUserId = targetUser.id;
      targetDetails = {
        username: targetUser.username,
        fullName: [targetUser.first_name, targetUser.last_name].filter(Boolean).join(' ')
      };
    }

    // B. Cible par mention @username dans le texte
    if (!targetUserId) {
      const matchUsername = text.match(/@([a-zA-Z0-9_]{3,32})/);
      if (matchUsername) {
        const candidate = matchUsername[1];
        if (!botUsername || candidate.toLowerCase() !== botUsername.toLowerCase()) {
          const resolvedId = db.getUserIdByUsername(candidate);
          if (resolvedId) {
            targetUserId = resolvedId;
            targetDetails = db.getUserDetails(resolvedId) || { username: candidate };
          } else {
            targetDetails = { username: candidate };
          }
        }
      }
    }

    // C. Cible par ID numérique dans le texte
    if (!targetUserId) {
      const matchId = text.match(/\b(\d{6,12})\b/);
      if (matchId) {
        targetUserId = Number(matchId[1]);
        targetDetails = db.getUserDetails(targetUserId) || {};
      }
    }

    // D. Si aucun utilisateur n'a pu être identifié
    if (!targetUserId && !targetDetails?.username) {
      const botReply = `👑 À vos ordres, Maître ! ✨ Indiquez-moi qui viser en répondant directement à son message ou en me précisant son @pseudo, et votre volonté sera faite sur-le-champ ! ⚡`;
      await ctx.reply(
        `👑 <b>À vos ordres, Maître !</b> ✨\n\n` +
        `Indiquez-moi qui viser en <b>répondant directement à son message</b> ou en me précisant son <b>@pseudo</b>, et votre volonté sera faite sur-le-champ ! ⚡`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      return true;
    }

    // Sanity checks : Ne pas cibler le maître lui-même ni le bot
    if (targetUserId && targetUserId === ctx.from.id) {
      const botReply = `👑 Jamais au grand jamais, Maître ! Je ne saurais porter la main sur mon divin créateur et maître absolu ! ✨`;
      await ctx.reply(
        `👑 <b>Jamais au grand jamais, Maître !</b>\n` +
        `Je ne saurais porter la main sur mon divin créateur et maître absolu ! ✨`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      return true;
    }

    if (botUsername && targetDetails?.username && targetDetails.username.toLowerCase() === botUsername.toLowerCase()) {
      const botReply = `👑 Maître, vous ne pouvez pas me bannir moi-même ! 😂 Je suis votre humble servante dévouée ! ✨`;
      await ctx.reply(
        `👑 Maître, vous ne pouvez pas me bannir moi-même ! 😂 Je suis votre humble servante dévouée ! ✨`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      return true;
    }

    const targetLabel = targetDetails?.username
      ? `@${escapeHtml(targetDetails.username)}`
      : (targetDetails?.fullName ? `<b>${escapeHtml(targetDetails.fullName)}</b>` : `ID:<code>${targetUserId}</code>`);

    const rawTargetName = targetDetails?.username ? `@${targetDetails.username}` : (targetDetails?.fullName || `ID:${targetUserId}`);

    // 2. Exécution de l'ordre selon l'action voulue
    if (isBanOrder) {
      if (!targetUserId) {
        targetUserId = db.getUserIdByUsername(targetDetails.username);
      }
      if (targetUserId) {
        await ActionManager.executeBan(ctx, targetUserId, targetDetails, "Ordre direct de Sa Majesté le Maître");
      }
      const botReply = `Votre ordre est exécuté, maître. ✨👑 L'utilisateur ${rawTargetName} a été banni selon votre volonté suprême.`;
      await ctx.reply(
        `Votre ordre est exécuté, maître. ✨👑\n` +
        `L'utilisateur ${targetLabel} a été banni selon votre volonté suprême.`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      this.lastInterventionTime = Date.now();
      this.messagesSinceLastIntervention = 0;
      return true;
    }

    if (isMuteOrder) {
      let minutes = 15;
      const minMatch = text.match(/(\d+)\s*(m|min|minute|minutes|h|heure|heures)?/i);
      if (minMatch) {
        const val = parseInt(minMatch[1], 10);
        if (/h/i.test(minMatch[2])) minutes = val * 60;
        else minutes = val;
      }

      if (!targetUserId) {
        targetUserId = db.getUserIdByUsername(targetDetails.username);
      }
      if (targetUserId) {
        await ActionManager.executeMute(ctx, targetUserId, targetDetails, "Ordre direct de Sa Majesté le Maître", minutes);
      }
      const botReply = `Votre ordre est exécuté, maître. ✨👑 L'utilisateur ${rawTargetName} a été réduit au silence pour ${minutes} minute(s).`;
      await ctx.reply(
        `Votre ordre est exécuté, maître. ✨👑\n` +
        `L'utilisateur ${targetLabel} a été réduit au silence pour ${minutes} minute(s).`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      this.lastInterventionTime = Date.now();
      this.messagesSinceLastIntervention = 0;
      return true;
    }

    if (isUnbanOrder) {
      if (!targetUserId) {
        targetUserId = db.getUserIdByUsername(targetDetails.username);
      }
      if (targetUserId) {
        await ActionManager.executeUnban(ctx, targetUserId);
      }
      const botReply = `Votre ordre est exécuté, maître. ✨👑 L'utilisateur ${rawTargetName} a été gracié et débanni sur votre commandement.`;
      await ctx.reply(
        `Votre ordre est exécuté, maître. ✨👑\n` +
        `L'utilisateur ${targetLabel} a été gracié et débanni sur votre commandement.`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      this.lastInterventionTime = Date.now();
      this.messagesSinceLastIntervention = 0;
      return true;
    }

    if (isUnmuteOrder) {
      if (!targetUserId) {
        targetUserId = db.getUserIdByUsername(targetDetails.username);
      }
      if (targetUserId) {
        await ActionManager.executeUnmute(ctx, targetUserId);
      }
      const botReply = `Votre ordre est exécuté, maître. ✨👑 La parole a été rendue à l'utilisateur ${rawTargetName} selon vos désirs.`;
      await ctx.reply(
        `Votre ordre est exécuté, maître. ✨👑\n` +
        `La parole a été rendue à l'utilisateur ${targetLabel} selon vos désirs.`,
        { reply_to_message_id: message.message_id, parse_mode: 'HTML' }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
      this.lastInterventionTime = Date.now();
      this.messagesSinceLastIntervention = 0;
      return true;
    }

    return false;
  }

  /**
   * Intercepte les tentatives d'ordres de sanction par un utilisateur non-maître
   */
  static async handleNonMasterOrderAttempt(ctx, text, botUsername, userDetails) {
    const message = ctx.message;
    if (!message) return false;

    console.log(`[NON-MASTER BLOCKED] 🚫 Tentative d'ordre naturel par un non-maître (${userDetails.username || userDetails.fullName}) : "${text}"`);

    const master = db.getMaster();
    const masterMention = master.username ? `@${escapeHtml(master.username)}` : null;

    this.lastMasterAlertTime = Date.now();

    if (masterMention) {
      const rawMasterUsername = master.username ? `@${master.username}` : 'Maître';
      const botReply = `✋ Non, je ne peux pas faire ça, vous n'avez pas assez de droits dans ce groupe !\n\n👑 Maître ${rawMasterUsername}, venez voir, il y a un problème ! Quelqu'un réclame une sanction ici... Qu'ordonne Sa Majesté ? ✨`;
      await ctx.reply(
        `✋ <b>Non, je ne peux pas faire ça, vous n'avez pas assez de droits dans ce groupe !</b>\n\n` +
        `👑 <b>Maître ${masterMention}</b>, venez voir, il y a un problème ! Quelqu'un réclame une sanction ici... Qu'ordonne Sa Majesté ? ✨`,
        {
          reply_to_message_id: message.message_id,
          parse_mode: 'HTML'
        }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
    } else {
      const botReply = `✋ Non, je ne peux pas faire ça, vous n'avez pas assez de droits dans ce groupe ! Seul mon Maître et créateur a le pouvoir de m'ordonner une telle sanction. ✨`;
      await ctx.reply(
        `✋ <b>Non, je ne peux pas faire ça, vous n'avez pas assez de droits dans ce groupe !</b> Seul mon Maître et créateur a le pouvoir de m'ordonner une telle sanction. ✨`,
        {
          reply_to_message_id: message.message_id,
          parse_mode: 'HTML'
        }
      );
      this.addRecentMessage('Léna (Modératrice)', botReply, true);
    }

    this.lastInterventionTime = Date.now();
    this.messagesSinceLastIntervention = 0;
    return true;
  }

  /**
   * Détecte si un message dans le groupe demande un lien, du streaming ou une émission
   */
  static detectShowOrLinkRequest(text) {
    if (!text || typeof text !== 'string') return { isRequest: false, matchedShow: null, isSpecificQuery: false };

    const lower = text.toLowerCase().trim();

    // 1. Mots-clés directs de liens, streaming, épisodes, visionnage
    const hasLinkKeywords = /\b(lien|liens|link|links|streaming|stream|ou\s*regarder|où\s*regarder|ou\s*voir|où\s*voir|ou\s*trouver|où\s*trouver|comment\s*(voir|regarder)|site\s*(pour|streaming)?|episodes?|épisodes?|saison\s*\d+|rediffusion|replay)\b/i.test(lower);

    // 2. Verbes ou expressions d'intention de demande / obtention
    const hasRequestIntent = /\b(veux|veut|cherche|trouver|avoir|donne|donnez|passe|passez|partage|partagez|balance|balancez|envoie|envoyez|dispo|disponible|quelqu'?un\s*a|vous\s*avez|tu\s*as|peux[- ]tu\s*(me\s*)?(passer|donner|envoyer)|je\s*peux\s*avoir)\b/i.test(lower);

    // 3. Recherche dans le catalogue des émissions
    const matchedShow = db.findShow(lower);

    // Cas A : Une émission du catalogue est mentionnée ET (mots de lien OU intention de demande OU question OU message court)
    if (matchedShow) {
      if (hasLinkKeywords || hasRequestIntent || lower.includes('?') || lower.length < 70) {
        return { isRequest: true, matchedShow, isSpecificQuery: true };
      }
    }

    // Cas B : Mots de lien/streaming explicites sans émission connue
    if (hasLinkKeywords) {
      const genericStopWords = new Set([
        'svp', 'stp', 'merci', 'please', 'qui', 'quoi', 'bonjour', 'salut', 'coucou',
        'amis', 'potes', 'team', 'gars', 'les', 'des', 'du', 'de', 'le', 'la', 'un',
        'une', 'a', 'avez', 'as', 'ont', 'pour', 'sur', 'dans', 'quelqu', 'quelquun',
        'passer', 'donner', 'envoyer', 'partager', 'avoir', 'veux', 'cherche', 'tu', 'vous'
      ]);
      const cleaned = lower
        .replace(/\b(ou\s*regarder|où\s*regarder|lien|liens|link|links|streaming|stream|quelqu'?un|vous|tu|avez|as|passer|donner|envoyer|partager|site|comment|voir|regarder)\b/gi, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .trim();

      const tokens = cleaned.split(/\s+/).filter(w => w.length >= 3 && !genericStopWords.has(w));
      const isSpecificQuery = tokens.length > 0;
      return { isRequest: true, matchedShow: null, isSpecificQuery };
    }

    // Cas C : Intention de demande avec des termes de télé-réalité
    if (hasRequestIntent && /\b(tele|télé|emission|émission|serie|série|programme|saison|prime)\b/i.test(lower)) {
      return { isRequest: true, matchedShow: null, isSpecificQuery: false };
    }

    return { isRequest: false, matchedShow: null, isSpecificQuery: false };
  }

  /**
   * Gestion des réponses conversationnelles et interventions intelligentes du bot
   */
  static async handleSmartReply(ctx, text, botUsername, userDetails) {
    const message = ctx.message;
    const authorName = userDetails.fullName || userDetails.username || 'Membre';

    // 1. Mémorisation du message dans l'historique récent s'il n'y est pas déjà
    const lastMsg = this.recentMessages[this.recentMessages.length - 1];
    if (!lastMsg || lastMsg.text !== text || lastMsg.userName !== authorName) {
      this.addRecentMessage(authorName, text, false);
    }
    this.messagesSinceLastIntervention++;

    // =========================================================================
    // PRIORITÉ ABSOLUE : DEMANDE DE LIEN OU DE TÉLÉ-RÉALITÉ (RÈGLE D'OR ANTI-LEAK)
    // S'exécute TOUJOURS en premier, même si l'utilisateur tague Léna ou répond au bot !
    // =========================================================================
    const showLinkCheck = this.detectShowOrLinkRequest(text);
    if (showLinkCheck.isRequest) {
      console.log(`[MODERATOR] 📺 Demande de lien télé-réalité détectée dans le groupe par ${authorName} ("${text}")`);
      const safeAuthor = escapeHtml(authorName);

      if (showLinkCheck.matchedShow) {
        // La série existe dans le catalogue : redirection vers les MP sans diffuser de lien et SANS arobase à la fin
        const replyMsg = `💬 Coucou <b>${safeAuthor}</b> ! Envoyez-moi un message en privé pour que je vous donne le lien de <b>${escapeHtml(showLinkCheck.matchedShow.name)}</b> ! 🍿`;
        await ctx.reply(replyMsg, {
          reply_to_message_id: message.message_id,
          parse_mode: 'HTML'
        }).catch(() => {});
        this.addRecentMessage('Léna (Modératrice)', `Envoyez-moi un message en privé pour que je vous donne le lien de ${showLinkCheck.matchedShow.name} !`, true);
      } else if (showLinkCheck.isSpecificQuery) {
        // La série spécifique demandée n'est pas encore disponible
        const replyMsg = `📺 Coucou <b>${safeAuthor}</b> ! Pour l'instant, cette télé-réalité n'est pas encore disponible dans nos canaux. Reste à l'affût ! ✨`;
        await ctx.reply(replyMsg, {
          reply_to_message_id: message.message_id,
          parse_mode: 'HTML'
        }).catch(() => {});
        this.addRecentMessage('Léna (Modératrice)', replyMsg.replace(/<[^>]+>/g, ''), true);
      } else {
        // Demande générale de lien
        const replyMsg = `💬 Coucou <b>${safeAuthor}</b> ! Envoyez-moi un message en privé pour que je vous donne le lien ! 🍿`;
        await ctx.reply(replyMsg, {
          reply_to_message_id: message.message_id,
          parse_mode: 'HTML'
        }).catch(() => {});
        this.addRecentMessage('Léna (Modératrice)', replyMsg.replace(/<[^>]+>/g, ''), true);
      }

      this.lastInterventionTime = Date.now();
      this.messagesSinceLastIntervention = 0;
      return;
    }

    // =========================================================================
    // CAS 1 : Sollicitation directe (Interpellation du bot ou Débriefing du Maître)
    // =========================================================================
    const lowerText = text.toLowerCase();
    const isBotMentioned = (
      (botUsername && text.includes(`@${botUsername}`)) ||
      /\b(lena|léna|sarah|bot|robot|modo|modérateur|moderateur|modératrice|admin|administrateur)\b/i.test(text)
    );

    const isReplyToBot = message.reply_to_message &&
      message.reply_to_message.from &&
      message.reply_to_message.from.is_bot;

    const isMaster = db.isMaster(ctx.from);

    // Détection si le Maître intervient suite à une alerte récente (moins de 5 min) ou demande ce qui se passe
    const isRecentMasterAlert = Boolean(this.lastMasterAlertTime && (Date.now() - this.lastMasterAlertTime < 5 * 60 * 1000));
    const isMasterAskingSituation = isMaster && (
      isRecentMasterAlert ||
      /\b(se passe quoi|qui se passe|quoi le (problème|souci)|qui a fait quoi|explique|raconte|qu'?est[ -]?ce qu'?il y a|pourquoi tu m'?as (appelé|ping|notifi[ée])|qui t'?a appel[ée]|qu'?as[ -]?tu|un problème|c'?est quoi|quoi de neuf)\b/i.test(text)
    );

    const isDirectCall = isBotMentioned || isReplyToBot || isMasterAskingSituation;

    if (isDirectCall) {
      if (isMaster && this.lastMasterAlertTime) {
        this.lastMasterAlertTime = 0;
      }

      const allowMimicry = conversationSessions.shouldAllowGroupMimicry(12);
      
      // OPTIMISATION ADAPTATIVE DE CONTEXTE (-75% de tokens consommés) :
      // 20 messages uniquement si demande de situation/débriefing, sinon 3 messages suffisent amplement !
      const isSituationQuery = (
        isMasterAskingSituation ||
        /\b(se passe quoi|qui se passe|quoi le (problème|probleme|souci)|qui a fait quoi|explique|raconte|qu'?est[ -]?ce qu'?il y a|pourquoi tu m'?as (appelé|appele|ping|notifié|notifie)|qui t'?a appel[ée]|un problème|c'?est quoi|résumé|resume|quoi de neuf)\b/i.test(text)
      );
      const contextDepth = isSituationQuery ? 20 : 3;
      const recentHistory = this.getRecentMessages(contextDepth);

      console.log(`[BOT REASONING] Réponse directe demandée par ${authorName} (isMaster: ${isMaster}, allowMimicry: ${allowMimicry}, context: ${contextDepth} msgs) ("${text}")`);
      const cleanedText = botUsername ? text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim() : text;
      const botResponse = await geminiService.generateReply(
        cleanedText,
        authorName,
        isMaster,
        allowMimicry,
        recentHistory
      );

      if (botResponse) {
        try {
          await ctx.reply(botResponse, { reply_to_message_id: message.message_id });
          this.addRecentMessage('Léna (Modératrice)', botResponse, true);
          conversationSessions.recordGroupTurn(allowMimicry);
          this.lastInterventionTime = Date.now();
          this.messagesSinceLastIntervention = 0;
        } catch (replyErr) {
          console.error('[BOT] Erreur lors de l\'envoi de la réponse:', replyErr.message);
        }
      }
      return;
    }

    // CAS 2 : Intervention autonome (Appels à l'aide, Tensions qui montent, Questions réelles)

    // Détection des appels à l'aide ou confusions (ex: "j'ai besoin d'aide les amis, qui peut m'aider", "c'est bizarre", "aidez-moi")
    const hasHelpSigns = /\b(aide|aider|aidez[ -]?moi|besoin d'?aide|qui peut m'?aider|qui peut m'?expliquer|au secours|sos|comprends? (rien|pas)|c'?est bizarre|probleme|problème|souci|bloqu[ée]|marche pas|fonctionne pas|perdu|des questions)\b/i.test(text);

    // Détection des tensions et disputes naissantes
    const hasTensionSigns = /\b(calme[ -]?toi|parle\s*bien|tu\s*(dis|fais)\s*n'?importe\s*quoi|arrete\s*de\s*mentir|tu\s*(me)?\s*chauffes?|t'?es\s*qui\s*toi|n'?importe\s*quoi|ferme\s*(la|ta gueule)|abuses?|ridicule|pathétique|tocard|degage|dégage|fous[ -]?moi la paix|bouffon|casse[ -]?toi)\b/i.test(text);

    // Détection des questions sur l'émission, les règles ou le fonctionnement
    const hasQuestionSigns = (
      /\b(qui\s*a\s*(ete\s*)?(elimine|vire|gagne)|a\s*quelle\s*heure|c'?est\s*(qui|quoi|quand|vrai|ou|où)|comment\s*(faire|on|voir)|quelqu'?un\s*(sait|peut)|c'?est\s*quand\s*le\s*prochain|ou\s*regarder|pourquoi|est[ -]?ce\s*que)\b/i.test(text) ||
      (text.includes('?') && text.split(/\s+/).length >= 3)
    );

    // Anti-spam pour les questions ordinaires : 20s et 2 messages
    const timeSinceLast = Date.now() - this.lastInterventionTime;
    const isCooldownActive = timeSinceLast < 20000 && this.messagesSinceLastIntervention < 2;

    // Taux de réponse aléatoire éventuel (si configuré)
    const randomIntervention = config.spontaneousReplyRate > 0 && Math.random() < config.spontaneousReplyRate;

    // Priorité absolue : les appels à l'aide et les tensions contournent le cooldown !
    const shouldEvaluate = (
      hasHelpSigns ||
      hasTensionSigns ||
      ((hasQuestionSigns || randomIntervention) && !isCooldownActive)
    );

    if (shouldEvaluate) {
      console.log(`[BOT REASONING] Évaluation d'intervention autonome pour le message de ${authorName} (Help: ${hasHelpSigns}, Tension: ${hasTensionSigns})...`);
      
      const evaluation = await geminiService.evaluateIntervention(this.getRecentMessages(20), text, authorName);
      
      if (evaluation.shouldReply && evaluation.suggestedReply) {
        console.log(`[INTERVENTION AUTONOME] ✅ Intervention validée (Raison : ${evaluation.reason}) : "${evaluation.suggestedReply}"`);
        try {
          await ctx.reply(evaluation.suggestedReply, {
            reply_to_message_id: message.message_id
          });
          this.addRecentMessage('Léna (Modératrice)', evaluation.suggestedReply, true);
          this.lastInterventionTime = Date.now();
          this.messagesSinceLastIntervention = 0;
        } catch (replyErr) {
          console.error('[BOT] Erreur envoi intervention autonome:', replyErr.message);
        }
      } else {
        console.log(`[BOT REASONING] 🤫 Décision de rester silencieux (pas d'intervention requise).`);
      }
    }
  }
}
