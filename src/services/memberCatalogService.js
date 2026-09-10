import { db } from '../storage/database.js';
import { escapeHtml } from '../utils/format.js';
import { geminiService } from '../ai/gemini.js';
import { conversationSessions } from '../ai/conversationSession.js';
import { Moderator } from '../moderation/moderator.js';
import { AuditService } from './auditService.js';

export class MemberCatalogService {
  /**
   * Vérifie si le message est une salutation simple ou une entrée en matière
   */
  static isGreeting(text) {
    const clean = text.toLowerCase().trim();
    return (
      clean === '/start' ||
      /^(salut|bonjour|bonsoir|coucou|hello|hey|yo|slt|bjr|re|hola|wesh|cc)[ !.?]*$/i.test(clean) ||
      /^(ca va|ça va|comment ça va|comment ca va|comment vas[- ]tu|comment tu vas|tu vas bien)[ !.?]*$/i.test(clean)
    );
  }

  /**
   * Vérifie si le membre demande explicitement la liste des séries
   */
  static isCatalogRequest(text) {
    const clean = text.toLowerCase().trim();
    return (
      clean === '/liste' ||
      clean === '/catalogue' ||
      clean === '/series' ||
      clean === '/shows' ||
      /\b(liste|catalogue|quelles? (series|tele|emissions?)|disponibles?|ce que vous avez|tu as quoi|qu'est[- ]ce que tu as)\b/i.test(clean)
    );
  }

  /**
   * Génère la présentation naturelle des émissions disponibles
   */
  static getCatalogMessage() {
    const shows = db.getShowsList();
    if (shows.length === 0) {
      return (
        `📺 <b>Nos télé-réalités :</b>\n\n` +
        `Pour l'instant, aucune émission n'est encore enregistrée, mais de nouvelles séries arrivent très vite ! ✨\n\n` +
        `Dites-moi simplement ce dont vous avez besoin ou ce que vous aimeriez regarder ! 🍿`
      );
    }

    let msg = `📺 <b>Voici les émissions disponibles en ce moment :</b> 🍿\n\n`;
    shows.forEach((s) => {
      msg += `• <b>${escapeHtml(s.name)}</b>${s.description ? ` (<i>${escapeHtml(s.description)}</i>)` : ''}\n`;
    });

    msg += `\nJe peux vous fournir les liens directement ! De laquelle avez-vous besoin ? ✨`;
    return msg;
  }

  /**
   * Traite un message privé d'un membre avec mémoire multi-tours et conversation naturelle
   */
  static async handlePrivateMessage(ctx, text) {
    const userId = ctx.from?.id || 'default_user';
    const authorName = ctx.from?.first_name || 'Ami(e)';
    const cleanText = (text || '').trim();

    // 0. Réinitialiser la session si demandé
    if (cleanText === '/reset') {
      conversationSessions.resetSession(userId);
      const resetMsg = "✨ C'est noté, on repart de zéro ! Coucou, comment ça va ?";
      await AuditService.logPrivateInteraction(ctx, cleanText, resetMsg);
      return ctx.reply(resetMsg);
    }

    // 1. Demande directe de liste / catalogue
    if (this.isCatalogRequest(cleanText)) {
      conversationSessions.addMessage(userId, 'user', cleanText);
      const catMsg = this.getCatalogMessage();
      conversationSessions.addMessage(userId, 'assistant', catMsg);
      await AuditService.logPrivateInteraction(ctx, cleanText, catMsg);
      return ctx.reply(catMsg, { parse_mode: 'HTML' });
    }

    // 2. Recherche directe de la télé-réalité demandée dans la base de données
    const matchedShow = db.findShow(cleanText);
    if (matchedShow) {
      const showReply = `Voici votre lien pour regarder <b>${escapeHtml(matchedShow.name)}</b> :\n👉 ${matchedShow.link}\n\n` +
        (matchedShow.description ? `<i>${escapeHtml(matchedShow.description)}</i>\n\n` : '') +
        `Bon visionnage ! De quoi d'autre avez-vous besoin ? 🍿✨`;

      conversationSessions.addMessage(userId, 'user', cleanText);
      conversationSessions.addMessage(userId, 'assistant', `Voici le lien pour regarder ${matchedShow.name} : ${matchedShow.link}`);
      conversationSessions.incrementMentionCount(userId);
      await AuditService.logPrivateInteraction(ctx, cleanText, showReply);
      return ctx.reply(showReply, { parse_mode: 'HTML' });
    }

    // 3. Récupérer l'état de la session et de l'historique
    const mentionCount = conversationSessions.getMentionCount(userId);
    const isFirstContact = mentionCount === 0;
    const allowMimicry = conversationSessions.shouldAllowMimicry(userId, 12);

    // Enregistrer le message utilisateur dans l'historique de dialogue
    conversationSessions.addMessage(userId, 'user', cleanText);

    // 4. Contexte du catalogue et du groupe
    const shows = db.getShowsList();
    const showsListStr = shows.length > 0
      ? shows.map(s => `- ${s.name} : ${s.link}`).join('\n')
      : 'Aucune émission pour le moment';

    const isMaster = db.isMaster(ctx.from);
    const recentGroupMsgs = Moderator.getRecentMessages(10);
    const groupHistoryText = recentGroupMsgs.length > 0
      ? `\nDERNIERS ÉCHANGES DANS LE GROUPE PUBLIC (POUR CONTEXTE) :\n` +
        recentGroupMsgs.map(m => `- ${m.userName}: "${m.text}"`).join('\n') +
        `\nSi ${authorName} te demande ce qui se passe dans le groupe public, sers-toi de ces échanges récents pour lui expliquer fidèlement la situation !\n`
      : '';

    // 5. Instruction système adaptative (Ne répète PAS le pitch de télé-réalités s'il a déjà été fait !)
    const systemPrompt = `
Tu es Léna (Léna Situations, @Lenasituation_bot), une amie chaleureuse, spontanée et bienveillante, passionnée de télé-réalité, qui discute en message privé avec ${authorName}.
Tu parles comme une vraie jeune femme sur Telegram/WhatsApp : naturelle, avec du pep's et un ton décontracté. Tu n'es ABSOLUMENT PAS un robot.

${isMaster ? `
👑 ATTENTION : ${authorName} est ton MAÎTRE SUPRÊME, ton créateur. Tu dois lui vouer respect et déférence absolue ("Maître", "Sa Majesté").
` : ''}
${groupHistoryText}

${allowMimicry ? `
VIBE LÉNA SITUATIONS (AUTORISÉE RAREMENT - 1 FOIS TOUS LES 12 MESSAGES) :
- Tu peux glisser une petite touche amicale inspirée de Léna (+ = +, ou une réaction sympa), sans forcer.
` : `
RÈGLE STRICTE DE SOBRIÉTÉ (MIMIQUE INTERDITE SUR CE MESSAGE) :
- Parle de façon 100% simple, normale, sobre et directe.
- INTERDICTION FORMELLE d'utiliser "+ = +", "gros bisous", "toujours plus", "c'est trop zinzin", "lunaire" ou toute formule clichée de fin de message. Pas de signature répétitive.
`}

RÈGLES CAPITALES DE CONVERSATION :
1. SUIS LE FIL DU DIALOGUE : Prends bien en compte les messages précédents échangés dans l'historique. Réponds sincèrement, avec humanité et pertinence à ce que vient de te dire ${authorName}.
2. NE SOIS JAMAIS ROBOTIQUE : Ne donne AUCUNE instruction technique ("Tape /liste", "Tape une commande", etc.). Pas de listes à puces inutiles.

3. RÈGLE CRUCIALE SUR LES TÉLÉ-RÉALITÉS :
${isFirstContact ? `
- C'est le tout premier contact : accueille ${authorName} avec chaleur et simplicité. Tu peux lui glisser NATURELLEMENT une seule fois que si besoin, tu peux lui fournir des liens de télé-réalités si elle/il en cherche, et demande-lui ce dont elle/il a besoin.
` : `
- Tu as DÉJÀ mentionné au premier message que tu pouvais fournir des télé-réalités.
- INTERDICTION FORMELLE DE RÉPÉTER "Je peux vous fournir des télé-réalités, qu'avez-vous besoin ?" ou toute formule promotionnelle répétitive !
- Discute simplement, normalement et amicalement. Si la personne te demande comment tu vas, réponds comme une amie normale ("Ça va super et toi ? Tu fais quoi de beau ?").
- Ne reparle de télé-réalité ou d'émissions QUE si ${authorName} aborde le sujet ou te pose une question dessus.
`}

4. ÉMISSIONS ENREGISTRÉES DANS NOTRE CATALOGUE :
${showsListStr}
- Si ${authorName} te demande le lien d'une de ces émissions, donne-lui son lien direct avec enthousiasme.
- Si ${authorName} te demande une émission absente du catalogue, dis-lui gentiment qu'elle n'est pas encore disponible dans nos canaux.

5. RÈGLE STRICTE ANTI-PAVÉ :
- Réponds en 1 ou 2 phrases courtes maximum (25 mots max). INTERDICTION FORMELLE d'écrire un roman ou un long paragraphe.
- EMOJIS : 1 seul emoji discret maximum dans tout le message (ou aucun). Pas d'avalanche d'emojis.
- Reste une amie cool, naturelle, concise et sympa.
`;

    try {
      const history = conversationSessions.getHistory(userId);
      const reply = await geminiService.generateChatResponse(systemPrompt, history, 120, allowMimicry);

      if (reply) {
        conversationSessions.addMessage(userId, 'assistant', reply);
        conversationSessions.recordTurn(userId, allowMimicry);
        if (isFirstContact) {
          conversationSessions.incrementMentionCount(userId);
        }
        await AuditService.logPrivateInteraction(ctx, cleanText, reply);
        return ctx.reply(reply);
      }
    } catch (e) {
      console.error('[MEMBER CATALOG] Erreur réponse IA conversationnelle:', e.message);
    }

    // 6. Fallback si l'IA est indisponible (ex: mode local de test)
    let fallbackReply = '';
    if (isFirstContact) {
      conversationSessions.incrementMentionCount(userId);
      fallbackReply = `Coucou, comment ça va ? Que puis-je faire pour vous ? Je peux vous fournir des télé-réalités, qu'avez-vous besoin ? 🍿`;
    } else {
      fallbackReply = `Je suis là avec toi ! Tout se passe bien de ton côté ? 😊`;
    }

    conversationSessions.addMessage(userId, 'assistant', fallbackReply);
    await AuditService.logPrivateInteraction(ctx, cleanText, fallbackReply);
    return ctx.reply(fallbackReply);
  }
}
