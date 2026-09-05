import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateLocalTextRules, normalizeText } from '../src/moderation/rules.js';
import { db } from '../src/storage/database.js';
import { ActionManager } from '../src/moderation/actionManager.js';
import { config } from '../src/config.js';
import { buildConversationPrompt, buildInterventionPrompt } from '../src/ai/prompts.js';
import { FloodProtector } from '../src/moderation/floodProtector.js';
import { LinkProtector } from '../src/moderation/linkProtector.js';
import { Moderator } from '../src/moderation/moderator.js';
import { ImageScanner } from '../src/moderation/imageScanner.js';
import { geminiService } from '../src/ai/gemini.js';
import { PrivateAdminManager } from '../src/admin/privateAdmin.js';

test('Normalisation de texte anti-contournement', () => {
  assert.equal(normalizeText('Puuuutain !'), 'puutain !');
  assert.equal(normalizeText('f.d.p'), 'fdp');
  assert.equal(normalizeText('f_d_p'), 'fdp');
  assert.equal(normalizeText('Mêrde'), 'merde');
});

test('Détection des insultes graves (BAN DIRECT)', () => {
  const severeCases = [
    'Espèce de fdp va',
    'f.d.p',
    'f_d_p',
    'Fils de pute casse-toi',
    'fils de pûte',
    'Nique ta mère',
    'ntm',
    'n.t.m',
    'Suce ma bite',
    'Sale pute dégage',
    'enculé'
  ];

  for (const phrase of severeCases) {
    const result = evaluateLocalTextRules(phrase);
    assert.ok(result, `Devrait être détecté : "${phrase}"`);
    assert.equal(result.action, 'ban', `Doit déclencher un BAN pour : "${phrase}"`);
    assert.equal(result.severity, 'severe');
  }
});

test('Détection des insultes légères et vulgarités (MUTE)', () => {
  const softCases = [
    'Oh merde alors !',
    'Fait chier ce candidat',
    'Putain c\'est n\'importe quoi',
    'Quel connard celui-là',
    'Ta gueule ferme la',
    'C\'est un bouffon'
  ];

  for (const phrase of softCases) {
    const result = evaluateLocalTextRules(phrase);
    assert.ok(result, `Devrait être détecté : "${phrase}"`);
    assert.equal(result.action, 'mute', `Doit déclencher un MUTE pour : "${phrase}"`);
    assert.equal(result.severity, 'soft');
  }
});

test('Messages normaux de télé-réalité (AUCUNE SANCTION)', () => {
  const normalCases = [
    'Qui a regardé le prime de Koh-Lanta hier ?',
    'Le clash entre les deux candidates dans Secret Story était énorme',
    'J\'espère que Julien va rester dans l\'aventure',
    'La stratégie des Cinquante est super intéressante cette semaine',
    'Bonjour à tous, bienvenue sur le canal !',
    'Est-ce que vous avez vu la story Instagram ?'
  ];

  for (const phrase of normalCases) {
    const result = evaluateLocalTextRules(phrase);
    assert.equal(result, null, `Ne devrait pas être sanctionné : "${phrase}"`);
  }
});

test('Gestion de la base de données, persistance et système de warn', () => {
  const testUserId = 99999999;
  
  // Test bannissement
  db.addBannedUser(testUserId, { username: 'test_troll', reason: 'Image NSFW' });
  assert.equal(db.isUserBanned(testUserId), true);
  
  const bannedInfo = db.getBannedUser(testUserId);
  assert.equal(bannedInfo.username, 'test_troll');
  assert.equal(bannedInfo.reason, 'Image NSFW');

  // Test dé-bannissement
  db.removeBannedUser(testUserId);
  assert.equal(db.isUserBanned(testUserId), false);

  // Test mise en sourdine (mute)
  db.addMutedUser(testUserId, { username: 'test_soft' }, 10);
  assert.equal(db.isUserMuted(testUserId), true);
  db.removeMutedUser(testUserId);
  assert.equal(db.isUserMuted(testUserId), false);

  // Test système de warnings
  const count1 = db.addWarning(testUserId, { by: 'Admin' }, 'Spam emoji');
  assert.equal(count1, 1);
  assert.equal(db.getWarnings(testUserId).length, 1);
  db.clearWarnings(testUserId);
  assert.equal(db.getWarnings(testUserId).length, 0);
});

test('Immunité des administrateurs et du propriétaire (Creator / Admin)', async () => {
  const fakeAdminId = 12345;
  config.adminUserIds = [fakeAdminId];

  // 1. Whitelist .env
  assert.equal(await ActionManager.isImmune({}, fakeAdminId), true);
  assert.equal(await ActionManager.isImmune({}, 99999), false);

  // 2. Mock Telegram Creator (Propriétaire)
  const mockOwnerCtx = {
    chat: { id: -100555666 },
    getChatMember: async (id) => ({ status: id === 7777 ? 'creator' : 'member' })
  };
  assert.equal(await ActionManager.isImmune(mockOwnerCtx, 7777), true);
  assert.equal(await ActionManager.isImmune(mockOwnerCtx, 8888), false);

  // 3. Mock Telegram Administrator
  const mockAdminCtx = {
    chat: { id: -100555666 },
    getChatMember: async (id) => ({ status: id === 9999 ? 'administrator' : 'member' })
  };
  assert.equal(await ActionManager.isImmune(mockAdminCtx, 9999), true);
});

test('Protection Anti-Flood', () => {
  const testSpammerId = 111222333;
  FloodProtector.reset(testSpammerId);

  // 4 premiers messages : pas de flood
  for (let i = 0; i < 4; i++) {
    const res = FloodProtector.checkFlood(testSpammerId);
    assert.equal(res.isFlooding, false);
  }

  // 5ème message dans la fenêtre : déclenchement du flood
  const triggered = FloodProtector.checkFlood(testSpammerId);
  assert.equal(triggered.isFlooding, true);
  assert.ok(triggered.count >= 5);
});

test('Protection Anti-Pub et Liens suspects', () => {
  // Liens interdits
  const badLinks = [
    'Rejoins mon canal t.me/mon_super_canal_leak',
    'Cliquez ici https://t.me/+AbCdEfGh123',
    'Regardez cette vidéo bit.ly/3xyzPromo',
    'Seulement sur onlyfans.com/sexy_fake',
    'Contactez mon wa.me/33612345678 pour du cash'
  ];

  for (const text of badLinks) {
    const res = LinkProtector.checkLinks(text, 'Lenasituation_bot');
    assert.equal(res.isBlocked, true, `Devrait être bloqué : "${text}"`);
  }

  // Liens autorisés (le bot lui-même ou texte normal)
  const goodLinks = [
    'Voici le lien du bot t.me/Lenasituation_bot',
    'Le site officiel mytf1.fr pour regarder Secret Story',
    'C\'est super sympa comme ambiance ici !'
  ];

  for (const text of goodLinks) {
    const res = LinkProtector.checkLinks(text, 'Lenasituation_bot');
    assert.equal(res.isBlocked, false, `Ne devrait PAS être bloqué : "${text}"`);
  }
});

test('Détection des expressions d\'aide et mentions du bot', () => {
  const helpPhrase = "J'ai besoin d'aide les amis, j'ai besoin d'aide, qui peut m'aider, où est le bot, c'est bizarre, etc.";

  const hasHelpSigns = /\b(aide|aider|aidez[ -]?moi|besoin d'?aide|qui peut m'?aider|qui peut m'?expliquer|au secours|sos|comprends? (rien|pas)|c'?est bizarre|probleme|problème|souci|bloqu[ée]|marche pas|fonctionne pas|perdu|des questions)\b/i.test(helpPhrase);
  assert.equal(hasHelpSigns, true, "Doit détecter l'appel à l'aide");

  const isBotMentioned = /\b(lena|léna|sarah|bot|robot|modo|modérateur|moderateur|modératrice|admin|administrateur)\b/i.test(helpPhrase);
  assert.equal(isBotMentioned, true, "Doit détecter la mention du bot");
});

test('Extraction et parsing JSON résistant pour Gemini', () => {
  const markdownFencedJson = '```json\n{\n  "isInappropriate": true,\n  "isAdultNsfw": true,\n  "severity": "severe",\n  "action": "ban",\n  "reason": "Nudité explicite"\n}\n```';
  const cleanJson = markdownFencedJson.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(cleanJson);

  assert.equal(parsed.isAdultNsfw, true);
  assert.equal(parsed.action, 'ban');
});

test('Construction du prompt conversationnel', () => {
  const prompt = buildConversationPrompt("Tu penses quoi de Vivian dans Les Cinquante ?", "Lucas", "Tu es Sarah la modératrice");
  assert.ok(prompt.includes("Lucas"));
  assert.ok(prompt.includes("Vivian"));
  assert.ok(prompt.includes("Sarah la modératrice"));
});

test('Échappement HTML sécurisé anti-crash Telegram', async () => {
  const { escapeHtml } = await import('../src/utils/format.js');
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('@Lenasituation_bot & friends'), '@Lenasituation_bot &amp; friends');
});

test('Résolution de cible par réponse directe (reply)', async () => {
  const { resolveTarget } = await import('../src/utils/resolver.js');
  
  const mockCtx = {
    message: {
      text: '/ban spam répété',
      reply_to_message: {
        from: { id: 112233, username: 'troll_user', first_name: 'Troll' }
      }
    }
  };

  const target = resolveTarget(mockCtx, 'ban');
  assert.equal(target.userId, 112233);
  assert.equal(target.userDetails.username, 'troll_user');
  assert.equal(target.reason, 'spam répété');
});

test('Résolution de cible pour commande /warn', async () => {
  const { resolveTarget } = await import('../src/utils/resolver.js');

  const mockCtx = {
    message: {
      text: '/warn insultes légères',
      reply_to_message: {
        from: { id: 445566, username: 'troublemaker', first_name: 'Bob' }
      }
    }
  };

  const target = resolveTarget(mockCtx, 'warn');
  assert.equal(target.userId, 445566);
  assert.equal(target.userDetails.username, 'troublemaker');
  assert.equal(target.reason, 'insultes légères');
});

test('Résolution de cible par @username', async () => {
  const { resolveTarget } = await import('../src/utils/resolver.js');
  
  db.saveUser(556677, { username: 'perturbe_tv', fullName: 'Perturbateur TV' });

  const mockCtx = {
    message: {
      text: '/mute @perturbe_tv 45 comportement toxique'
    }
  };

  const target = resolveTarget(mockCtx, 'mute');
  assert.equal(target.userId, 556677);
  assert.equal(target.userDetails.username, 'perturbe_tv');
  assert.equal(target.minutes, 45);
  assert.equal(target.reason, 'comportement toxique');
});

test('Résolution de cible par ID numérique direct', async () => {
  const { resolveTarget } = await import('../src/utils/resolver.js');

  const mockCtx = {
    message: {
      text: '/unban 888999'
    }
  };

  const target = resolveTarget(mockCtx, 'unban');
  assert.equal(target.userId, 888999);
});

test('Lecture dynamique du contexte bot (context.txt) et Vibe Léna Situations', async () => {
  const { getBotContext } = await import('../src/config.js');
  const ctx = getBotContext();
  assert.ok(ctx && ctx.length > 20);
  assert.ok(ctx.includes('télé-réalité') || ctx.includes('Télé-Réalité'));
  assert.ok(ctx.includes('Léna Situations') || ctx.includes('Léna'));
  assert.ok(ctx.includes('+ = +'));
  assert.ok(ctx.includes('Toujours plus'));
});

test('Prompt de conversation et intervention infusés de la vibe Léna Situations', async () => {
  const { buildConversationPrompt, INTERVENTION_EVALUATION_SYSTEM_INSTRUCTION } = await import('../src/ai/prompts.js');
  
  // 1. Par défaut (sobre)
  const soberPrompt = buildConversationPrompt("Coucou Léna !", "Chloé", "Contexte personnalisé", false, false);
  assert.ok(soberPrompt.includes("Léna (Léna Situations"));
  assert.ok(soberPrompt.includes("RÈGLE STRICTE DE SOBRIÉTÉ"));
  
  // 2. Quand la mimique est autorisée
  const mimicryPrompt = buildConversationPrompt("Coucou Léna !", "Chloé", "Contexte personnalisé", false, true);
  assert.ok(mimicryPrompt.includes("+ = +"));

  assert.ok(INTERVENTION_EVALUATION_SYSTEM_INSTRUCTION.includes("Léna Situations"));
});

test('Construction du prompt d\'intervention autonome avec aide', async () => {
  const recent = [
    { userName: 'Alex', text: 'Moi je préfère Julien' },
    { userName: 'Sam', text: 'Tu dis n\'importe quoi' }
  ];
  const prompt = buildInterventionPrompt(recent, 'J\'ai besoin d\'aide qui peut m\'expliquer les votes ?', 'Alex', 'Tu es Sarah');
  assert.ok(prompt.includes('Julien'));
  assert.ok(prompt.includes('J\'ai besoin d\'aide'));
  assert.ok(prompt.includes('Tu es Sarah'));
});

test('Gestion du propriétaire et groupe principal dans la base', () => {
  db.setMainGroupId(-100998877);
  assert.equal(db.getMainGroupId(), -100998877);

  const randomOwner = Math.floor(Math.random() * 8000000) + 1000000;
  const randomAdmin = Math.floor(Math.random() * 8000000) + 9000000;

  db.setOwnerId(randomOwner);
  assert.equal(db.getOwnerId(), randomOwner);
  assert.equal(db.isOwnerOrAdmin(randomOwner), true);
  assert.equal(db.isOwnerOrAdmin(randomAdmin), false);

  db.addAdminId(randomAdmin);
  assert.equal(db.isOwnerOrAdmin(randomAdmin), true);
});

test('Salle de contrôle privée et clavier interactif', async () => {
  const { PrivateAdminManager } = await import('../src/admin/privateAdmin.js');
  
  assert.equal(PrivateAdminManager.isAuthorized(db.getOwnerId()), true);
  const kb = PrivateAdminManager.getMainKeyboard();
  assert.ok(kb);
  assert.ok(kb.inline_keyboard.length >= 3);
});

test('Catalogue des Séries : Ajout, Recherche intelligente et Suppression', () => {
  // 1. Ajout de séries
  const villa = db.addShow("La Villa des Cœurs Brisés", "https://stream.tv/la-villa", "Saison 9");
  assert.ok(villa);
  assert.equal(villa.id, "la-villa-des-coeurs-brises");
  assert.ok(villa.aliases.includes("la villa des coeurs brises"));

  const secret = db.addShow("Secret Story", "https://stream.tv/secret", "Saison 12");
  assert.ok(secret);

  // 2. Recherche exacte et par alias
  assert.equal(db.findShow("la villa")?.id, "la-villa-des-coeurs-brises");
  assert.equal(db.findShow("villa")?.id, "la-villa-des-coeurs-brises");
  assert.equal(db.findShow("Donne-moi la villa stp")?.id, "la-villa-des-coeurs-brises");
  assert.equal(db.findShow("secret story")?.id, "secret-story");
  assert.equal(db.findShow("secret")?.id, "secret-story");
  assert.equal(db.findShow("Une émission inconnue"), null);

  // 3. Suppression
  const removed = db.removeShow("Secret Story");
  assert.equal(removed, true);
  assert.equal(db.findShow("secret story"), null);
});

test('Règle d\'Or Anti-Leak dans le groupe public : Redirection vers MP sans jamais divulguer de lien ni taguer son arobase', async () => {
  // Enregistrer La Villa dans la base
  db.addShow("La Villa des Cœurs Brisés", "https://lien-secret-confidentiel.com/villa", "Saison 9");

  const { Moderator } = await import('../src/moderation/moderator.js');

  let sentMessage = '';
  const mockCtx = {
    message: {
      message_id: 1234,
      text: "Quelqu'un a le lien pour regarder La Villa svp ?"
    },
    from: { id: 78910, first_name: 'Sophie' },
    reply: async (text) => {
      sentMessage = text;
    }
  };

  await Moderator.handleSmartReply(mockCtx, mockCtx.message.text, 'Lenasituation_bot', { fullName: 'Sophie' });

  // VÉRIFICATION CRITIQUE :
  // 1. Le message doit inviter à écrire en privé
  assert.ok(sentMessage.includes('message en privé'), "Doit inviter à venir en privé");
  assert.ok(sentMessage.includes('La Villa des Cœurs Brisés'), "Doit citer l'émission");
  // 2. Le message NE DOIT PAS ajouter son @ à la fin (les utilisateurs cliquent sur l'avatar)
  assert.equal(sentMessage.includes('@Lenasituation_bot'), false, "Ne doit pas taguer son @ à la fin");
  // 3. Le message NE DOIT EN AUCUN CAS contenir le lien réel https://...
  assert.equal(sentMessage.includes('https://lien-secret-confidentiel.com'), false, "NE DOIT JAMAIS FUITER LE LIEN DANS LE GROUPE");
});

test('Service Membre en MP : Salutations naturelles, sans /liste robotique et Livraison de lien', async () => {
  const { MemberCatalogService } = await import('../src/services/memberCatalogService.js');

  // Test détection salutations
  assert.equal(MemberCatalogService.isGreeting("Bonjour"), true);
  assert.equal(MemberCatalogService.isGreeting("salut"), true);
  assert.equal(MemberCatalogService.isGreeting("comment ça va ?"), true);
  assert.equal(MemberCatalogService.isGreeting("La Villa"), false);

  let memberPrivateReply = '';
  const mockMemberCtx = {
    from: { id: 334455, first_name: 'Camille' },
    reply: async (text) => {
      memberPrivateReply = text;
    }
  };

  // 1. Premier message : accueil naturel et spontané
  await MemberCatalogService.handlePrivateMessage(mockMemberCtx, "Bonjour");
  assert.ok(memberPrivateReply.length > 0, "Doit répondre chaleureusement");
  assert.equal(memberPrivateReply.includes('/liste'), false, "Zéro mention de /liste robotique");

  // 2. Deuxième message : suivi de conversation et non-répétition de pitch
  await MemberCatalogService.handlePrivateMessage(mockMemberCtx, "Ça va super et toi ?");
  assert.equal(memberPrivateReply.includes("Je peux vous fournir des télé-réalités, qu'avez-vous besoin ?"), false, "NE DOIT PAS répéter le pitch en boucle");
  assert.ok(memberPrivateReply.length > 0, "Doit converser naturellement et suivre le fil");

  // 3. En MP, si le membre demande "La Villa", il doit recevoir le lien
  await MemberCatalogService.handlePrivateMessage(mockMemberCtx, "La Villa");
  assert.ok(memberPrivateReply.includes('https://lien-secret-confidentiel.com/villa'), "En MP, le lien doit être délivré");
  assert.ok(memberPrivateReply.includes('La Villa des Cœurs Brisés'));
  assert.equal(memberPrivateReply.includes('/liste'), false);

  // 4. En MP, si le membre demande une émission inconnue
  await MemberCatalogService.handlePrivateMessage(mockMemberCtx, "Je cherche Game of Thrones");
  assert.ok(memberPrivateReply.length > 0, "Réponse naturelle");
  assert.equal(memberPrivateReply.includes('/liste'), false, "Pas de mention de /liste");
});

test('Système de Sauvegarde : Double Redondance, Backups Rotatifs et Restauration Automatique', async () => {
  // 1. Ajouter une émission
  db.addShow("Les Cinquante", "https://stream.tv/50", "Saison 3");

  // 2. Vérifier que l'émission est présente
  assert.ok(db.findShow("cinquante"));

  // 3. Créer une sauvegarde
  const backup = db.createBackup("Test backup unitaire");
  assert.ok(backup);
  assert.ok(backup.filename.startsWith("backup_"));
  assert.ok(backup.showsCount >= 1);

  // 4. Lister les sauvegardes
  const backupsList = db.listBackups();
  assert.ok(Array.isArray(backupsList));
  assert.ok(backupsList.length >= 1);

  // 5. Tester la restauration de secours si la base en mémoire est vidée
  db.data.shows = {}; // Simule une perte accidentelle
  assert.equal(Object.keys(db.data.shows).length, 0);

  // Restauration depuis backup
  const restored = db.restoreFromLatestBackup();
  assert.equal(restored, true);
  assert.ok(db.findShow("cinquante"), "Doit avoir restauré l'émission avec succès");
});

test('Statut de Maître Suprême & Ordres Naturels de modération', async () => {
  const { Moderator } = await import('../src/moderation/moderator.js');

  // 1. Définition du Maître par son @username
  db.setMaster('@MonCreateurAdore');
  assert.equal(db.getMaster().username, 'moncreateuradore');
  assert.equal(db.isMaster({ username: 'MonCreateurAdore', id: 778899 }), true);
  assert.equal(db.isMaster({ username: 'UnAutreMembre', id: 123456 }), false);

  // 2. Le Maître dit "Tu peux bannir celui-là" en répondant à un message de troll
  let replySent = '';
  const mockMasterCtx = {
    from: { id: 778899, username: 'MonCreateurAdore', first_name: 'Dieu' },
    message: {
      message_id: 999,
      text: "Tu peux bannir celui-là",
      reply_to_message: {
        from: { id: 666777, username: 'troll_relou', first_name: 'Troll' }
      }
    },
    reply: async (text) => {
      replySent = text;
    },
    banChatMember: async () => true,
    chat: { id: -1001234567 }
  };

  await Moderator.processMessage(mockMasterCtx, 'Lenasituation_bot');
  assert.ok(replySent.includes('Votre ordre est exécuté, maître'), "Doit confirmer avec déférence l'exécution de l'ordre");
  assert.ok(db.isUserBanned(666777), "La cible doit être bannie de la base de données");

  // 3. Si un membre ordinaire non-maître dit "Tu peux bannir celui-là", il doit être bloqué et le Maître alerté
  let nonMasterReply = '';
  const mockNormalCtx = {
    from: { id: 111222, username: 'lambda_user', first_name: 'Jean' },
    message: {
      message_id: 1000,
      text: "Tu peux bannir celui-là",
      reply_to_message: {
        from: { id: 333444, username: 'autre_user', first_name: 'Paul' }
      }
    },
    reply: async (text) => {
      nonMasterReply = text;
    },
    banChatMember: async () => true,
    chat: { id: -1001234567 }
  };

  await Moderator.processMessage(mockNormalCtx, 'Lenasituation_bot');
  assert.equal(nonMasterReply.includes('Votre ordre est exécuté, maître'), false, "Un membre ordinaire ne peut pas déclencher l'ordre");
  assert.ok(nonMasterReply.includes('Non, je ne peux pas faire ça'), "Doit refuser poliment l'ordre");
  assert.ok(nonMasterReply.toLowerCase().includes('@moncreateuradore'), "Doit taguer le Maître pour lui demander son avis");
  assert.equal(db.isUserBanned(333444), false, "La cible ne doit pas être bannie");
});

test('Déférence au Maître dans buildConversationPrompt et Chat Privé', async () => {
  const { buildConversationPrompt } = await import('../src/ai/prompts.js');
  const promptMaster = buildConversationPrompt("Bonjour Léna", "MonCreateurAdore", "Contexte", true);
  assert.ok(promptMaster.includes('MAÎTRE SUPRÊME'), "Doit inclure l'ordre de déférence absolue");
  assert.ok(promptMaster.includes('Sa Majesté') || promptMaster.includes('Maître'));

  // Test en privé avec PrivateAdminManager
  const { PrivateAdminManager } = await import('../src/admin/privateAdmin.js');
  let privateReply = '';
  const mockPrivateMasterCtx = {
    from: { id: 778899, username: 'MonCreateurAdore', first_name: 'Dieu' },
    message: { message_id: 1001, text: "Tu es là ?" },
    reply: async (text) => {
      privateReply = text;
    }
  };

  await PrivateAdminManager.handlePrivateChat(mockPrivateMasterCtx, "Tu es là ?");
  assert.ok(privateReply.includes('Maître') || privateReply.includes('Sa Majesté'), "Le fallback privé doit s'adresser au Maître avec respect");
});

test('Gestion de la fréquence des mimiques (1 fois tous les 10-15 messages) et nettoyage', async () => {
  const { sanitizeMimicryIfNeeded } = await import('../src/ai/prompts.js');
  const { conversationSessions } = await import('../src/ai/conversationSession.js');

  // 1. Sanitize nettoie les mimiques si allowMimicry est faux
  const textWithGimmicks = "Coucou ! Ça va super + = + Gros bisous à tous !";
  const cleaned = sanitizeMimicryIfNeeded(textWithGimmicks, false);
  assert.equal(cleaned.includes('+ = +'), false, "Doit supprimer + = +");
  assert.equal(cleaned.toLowerCase().includes('gros bisous'), false, "Doit supprimer gros bisous");

  // 2. Si allowMimicry est vrai, les mimiques sont préservées
  const preserved = sanitizeMimicryIfNeeded(textWithGimmicks, true);
  assert.ok(preserved.includes('+ = +'));

  // 3. Test du compteur de session
  const testUserId = 999111;
  conversationSessions.resetSession(testUserId);
  assert.equal(conversationSessions.shouldAllowMimicry(testUserId, 10), false, "Initialement, mimique interdite");

  // Incrémenter 10 tours
  for (let i = 0; i < 10; i++) {
    conversationSessions.recordTurn(testUserId, false);
  }
  assert.equal(conversationSessions.shouldAllowMimicry(testUserId, 10), true, "Après 10 messages, mimique autorisée");

  // Après usage de la mimique, reset à 0
  conversationSessions.recordTurn(testUserId, true);
  assert.equal(conversationSessions.shouldAllowMimicry(testUserId, 10), false, "Doit se réinitialiser à zéro");
});

test('Mémoire des 20 derniers messages du groupe & réponse contextuelle au Maître', async () => {
  const { buildConversationPrompt } = await import('../src/ai/prompts.js');
  const { geminiService } = await import('../src/ai/gemini.js');

  // 1. Test du tampon circulaire des messages récents (capacité 30, retrieval 20)
  Moderator.recentMessages = [];
  for (let i = 1; i <= 25; i++) {
    Moderator.addRecentMessage(`User${i}`, `Message numéro ${i}`, false);
  }
  const recent20 = Moderator.getRecentMessages(20);
  assert.equal(recent20.length, 20, "Doit renvoyer exactement 20 messages");
  assert.equal(recent20[0].userName, 'User6', "Le premier des 20 derniers doit être User6");
  assert.equal(recent20[19].userName, 'User25', "Le dernier des 20 derniers doit être User25");

  // 2. Test du prompt conversationnel avec historique
  const history = [
    { userName: 'Sophie', text: 'Quelqu\'un a le lien de Koh-Lanta ?', isBot: false },
    { userName: 'Julien', text: 'Tu peux bannir Sophie', isBot: false },
    { userName: 'Léna (Modératrice)', text: 'Non, je ne peux pas faire ça... Maître @moncreateuradore venez voir !', isBot: true }
  ];

  const prompt = buildConversationPrompt("Il se passe quoi ?", "MonCreateurAdore", "Contexte", true, false, history);
  assert.ok(prompt.includes('[HISTORIQUE DES 20 DERNIERS MESSAGES DU GROUPE'), "Doit inclure l'en-tête de l'historique");
  assert.ok(prompt.includes('Sophie : "Quelqu\'un a le lien de Koh-Lanta ?"'), "Doit inclure le message de Sophie");
  assert.ok(prompt.includes('Julien : "Tu peux bannir Sophie"'), "Doit inclure le message de Julien");
  assert.ok(prompt.includes('Léna (Toi/Modératrice)'), "Doit distinguer le rôle de Léna");
  assert.ok(prompt.includes('RÈGLE CRITIQUE D\'ANALYSE DE SITUATION'), "Doit imposer d'expliquer les faits réels");

  // 3. Test de la génération de réponse au Maître (mockMode / fallback)
  const masterReply = await geminiService.generateReply("Il se passe quoi ?", "MonCreateurAdore", true, false, history);
  assert.ok(masterReply.includes('Maître') || masterReply.includes('Sa Majesté'), "Doit appeler le Maître");
  assert.ok(masterReply.includes('Sophie') || masterReply.includes('Julien'), "Doit relater les faits récents réels avec les pseudos");

  // 4. Test d'intégration complet dans le flux du modérateur :
  // Le Maître demande "Il se passe quoi ?" sans mention @bot ni reply, suite à un appel du bot
  let repliedText = '';
  const mockMasterCtx = {
    from: { id: 778899, username: 'MonCreateurAdore', first_name: 'MonCreateurAdore' },
    message: {
      message_id: 8888,
      text: "Il se passe quoi ?",
      reply_to_message: null
    },
    chat: { id: -1001234567 },
    reply: async (text) => {
      repliedText = text;
    }
  };

  await Moderator.processMessage(mockMasterCtx, 'Lenasituation_bot');
  assert.ok(repliedText.length > 0, "Le bot doit répondre directement au Maître qui demande ce qui se passe");
  assert.ok(repliedText.includes('Maître') || repliedText.includes('Sa Majesté'), "La réponse doit s'adresser au Maître");
});

test('Gestion Multi-Maîtres & Indépendance stricte du Propriétaire (Owner vs Master)', async () => {
  const { PrivateAdminManager } = await import('../src/admin/privateAdmin.js');

  // 1. Initialement : définir un propriétaire (ex: GrandJD = 5514712683)
  db.setOwnerId(5514712683);
  assert.equal(db.getOwnerId(), 5514712683);

  // Le propriétaire n'est PAS un maître par défaut
  assert.equal(db.isMaster(5514712683), false, "Le propriétaire ne doit PAS être considéré comme Maître automatiquement");
  assert.equal(db.isMaster({ id: 5514712683, username: 'GrandJD' }), false, "GrandJD ne doit pas être Maître s'il n'est pas dans la liste");

  // 2. Ajouter un Maître explicite (@gankpai)
  db.addMaster('@gankpai');
  assert.equal(db.isMaster({ username: 'gankpai', id: 1661892692 }), true, "Gankpai doit être reconnu comme Maître");
  assert.equal(db.isMaster(1661892692), true, "Gankpai par ID doit être reconnu comme Maître");

  // Vérifier que le propriétaire n'est toujours pas maître
  assert.equal(db.isMaster({ id: 5514712683, username: 'GrandJD' }), false);

  // 3. Ajouter un deuxième Maître
  db.addMaster({ username: 'SecondMaster', id: 998877 });
  const masters = db.getMasters();
  assert.ok(masters.some(m => m.username === 'secondmaster'), "SecondMaster doit être dans la liste des maîtres");
  assert.equal(db.isMaster(998877), true);

  // 4. Retirer un Maître
  const removed = db.removeMaster('secondmaster');
  assert.equal(removed, true, "Doit confirmer la suppression de secondmaster");
  assert.equal(db.isMaster(998877), false, "SecondMaster ne doit plus être Maître");
  assert.equal(db.isMaster({ username: 'gankpai' }), true, "Gankpai doit toujours être Maître");

  // 5. Test des commandes interactives de PrivateAdminManager
  let replyText = '';
  const mockOwnerCtx = {
    from: { id: 5514712683, username: 'GrandJD', first_name: 'GrandJD' },
    reply: async (text) => { replyText = text; }
  };

  // /masters
  await PrivateAdminManager.listMastersCommand(mockOwnerCtx);
  assert.ok(replyText.includes('GESTION DES MAÎTRES SUPRÊMES'));
  assert.ok(replyText.includes('gankpai'));

  // /addmaster
  await PrivateAdminManager.addMasterCommand(mockOwnerCtx, '@NouveauRoi');
  assert.ok(replyText.includes('NOUVEAU MAÎTRE ENREGISTRÉ'));
  assert.equal(db.isMaster({ username: 'NouveauRoi' }), true);

  // /delmaster
  await PrivateAdminManager.delMasterCommand(mockOwnerCtx, '@NouveauRoi');
  assert.ok(replyText.includes('Maître retiré avec succès'));
  assert.equal(db.isMaster({ username: 'NouveauRoi' }), false);
});

test('Interception Prioritaire Anti-Leak dans le groupe : même avec mention du bot ou reply', async () => {
  // S'assurer que La Villa est dans le catalogue
  db.addShow('La Villa des Cœurs Brisés', 'https://t.me/+wluVMI3_rH4zZDI0', 'Saison 11');

  // Cas 1 : Demande directe "Je veux le lien de la Villa"
  let replied1 = '';
  const mockCtx1 = {
    from: { id: 887766, username: 'FanVilla', first_name: 'Fan' },
    message: {
      message_id: 2001,
      text: "Je veux le lien de la Villa",
      reply_to_message: null
    },
    chat: { id: -1001234567 },
    reply: async (text) => { replied1 = text; }
  };
  await Moderator.processMessage(mockCtx1, 'Lenasituation_bot');
  assert.ok(replied1.includes('Envoyez-moi un message en privé'), "Doit rediriger vers le MP");
  assert.ok(replied1.includes('La Villa des Cœurs Brisés'), "Doit mentionner le nom exact de la série");
  assert.equal(replied1.includes('https://'), false, "NE DOIT JAMAIS diffuser le lien dans le chat public");
  assert.equal(replied1.includes('coller'), false, "NE DOIT JAMAIS demander de coller le lien");

  // Cas 2 : Demande en mentionnant le bot ou en reply au bot
  let replied2 = '';
  const mockCtx2 = {
    from: { id: 887766, username: 'FanVilla', first_name: 'Fan' },
    message: {
      message_id: 2002,
      text: "@Lenasituation_bot Je veux le lien de la Villa",
      reply_to_message: { from: { id: 9999999, is_bot: true } }
    },
    chat: { id: -1001234567 },
    reply: async (text) => { replied2 = text; }
  };
  await Moderator.processMessage(mockCtx2, 'Lenasituation_bot');
  assert.ok(replied2.includes('Envoyez-moi un message en privé'));
  assert.ok(replied2.includes('La Villa des Cœurs Brisés'));
  assert.equal(replied2.includes('https://'), false);
  assert.equal(replied2.includes('coller'), false);

  // Cas 3 : Demande d'une série NON disponible
  let replied3 = '';
  const mockCtx3 = {
    from: { id: 887766, username: 'FanAutre', first_name: 'Fan' },
    message: {
      message_id: 2003,
      text: "Quelqu'un a le lien de Koh Lanta svp ?",
      reply_to_message: null
    },
    chat: { id: -1001234567 },
    reply: async (text) => { replied3 = text; }
  };
  await Moderator.processMessage(mockCtx3, 'Lenasituation_bot');
  assert.ok(replied3.includes("pas encore disponible"), "Doit annoncer que la série n'est pas disponible");
  assert.equal(replied3.includes('coller'), false);
});

test('Scanner d\'Images : Détection NSFW, Bannissement des membres standards et Immunité sécurisée des Admins', async () => {
  const originalAnalyze = geminiService.analyzeImage;
  const originalFetch = global.fetch;

  // Cas 1 : Membre standard qui envoie une image NSFW -> Doit être banni
  geminiService.analyzeImage = async () => ({
    isAdultNsfw: true,
    severity: 'severe',
    action: 'ban',
    reason: 'Nudité explicite détectée'
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
  });

  let deletedMessage = false;
  let banExecuted = false;
  const mockMemberCtx = {
    from: { id: 777111, username: 'TrollNsfw', first_name: 'Troll' },
    message: {
      message_id: 501,
      photo: [{ file_id: 'fake_photo_id' }]
    },
    chat: { id: -1001234567 },
    getFile: async () => ({ file_path: 'photos/file_0.jpg' }),
    deleteMessage: async () => { deletedMessage = true; },
    banChatMember: async () => { banExecuted = true; return true; },
    reply: async () => {}
  };

  const memberResult = await ImageScanner.scanMessage(mockMemberCtx, false);
  assert.equal(memberResult.handled, true);
  assert.equal(memberResult.action, 'ban');
  assert.equal(db.isUserBanned(777111), true);

  // Cas 2 : Admin qui envoie une image NSFW (ex: test de modération) -> Ne doit PAS être banni, mais image supprimée
  deletedMessage = false;
  let adminBanAttempted = false;
  const mockAdminCtx = {
    from: { id: 999111, username: 'AdminTester', first_name: 'Admin' },
    message: {
      message_id: 502,
      photo: [{ file_id: 'fake_photo_admin' }]
    },
    chat: { id: -1001234567 },
    getFile: async () => ({ file_path: 'photos/file_admin.jpg' }),
    deleteMessage: async () => { deletedMessage = true; },
    banChatMember: async () => { adminBanAttempted = true; return true; },
    reply: async () => {}
  };

  const adminResult = await ImageScanner.scanMessage(mockAdminCtx, true);
  assert.equal(adminResult.handled, true);
  assert.equal(adminResult.action, 'immune_deleted');
  assert.equal(deletedMessage, true, "L'image NSFW doit être supprimée du groupe même si envoyée par l'admin");
  assert.equal(adminBanAttempted, false, "L'administrateur ne doit JAMAIS être banni");
  assert.equal(db.isUserBanned(999111), false);

  // Cas 3 : Image propre conforme -> Laissée passer
  geminiService.analyzeImage = async () => ({
    isAdultNsfw: false,
    isInappropriate: false,
    severity: 'none',
    action: 'none',
    reason: 'Photo conforme'
  });

  const cleanResult = await ImageScanner.scanMessage(mockMemberCtx, false);
  assert.equal(cleanResult.handled, false);

  // Restauration
  geminiService.analyzeImage = originalAnalyze;
  global.fetch = originalFetch;
});

test('Diffusion Multi-Canaux & Multi-Groupes (/broadcast) : Envoi global, nettoyage des canaux morts et rapport', async () => {
  // 1. Initialiser des canaux et groupes de test
  db.addManagedChat(-1001001, 'Canal News Télé-Réalité', 'channel', 'telerealite_news');
  db.addManagedChat(-1001002, 'Canal Épisodes Exclusifs', 'channel', 'episodes_exclu');
  db.addManagedChat(-1001003, 'Groupe Public Discussions', 'supergroup', null);

  const allChats = db.getManagedChats();
  const channels = db.getManagedChannels();
  const groups = db.getManagedGroups();

  assert.ok(channels.some(c => c.id === -1001001), 'Le canal news doit être présent');
  assert.ok(channels.some(c => c.id === -1001002), 'Le canal épisodes doit être présent');
  assert.ok(groups.some(c => c.id === -1001003), 'Le groupe public doit être présent');
  assert.ok(channels.length >= 2, 'Il doit y avoir au moins 2 canaux');
  assert.ok(groups.length >= 1, 'Il doit y avoir au moins 1 groupe');

  // 2. Simuler un broadcast par un admin/maître
  // -1001001 : succès
  // -1001002 : bot exclu (doit être auto-nettoyé)
  // -1001003 : succès
  const sentMessages = [];
  let broadcastReplyReport = '';

  const mockAdminBroadcastCtx = {
    from: { id: 123456789, username: 'MyMaster' },
    chat: { id: 123456789, type: 'private' },
    api: {
      sendMessage: async (chatId, text, opts) => {
        if (chatId === -1001002) {
          throw new Error('Forbidden: bot was kicked from the channel chat');
        }
        sentMessages.push({ chatId, text, opts });
        return { message_id: 999 };
      },
      deleteMessage: async () => {}
    },
    reply: async (text) => {
      broadcastReplyReport = text;
    }
  };

  // Définir le user comme admin
  db.setOwnerId(123456789);

  await PrivateAdminManager.broadcastToAll(mockAdminBroadcastCtx, "Ce soir prime spécial à 21h sur toutes nos chaînes !");

  // Vérifications
  assert.ok(sentMessages.some(m => m.chatId === -1001001), 'Doit avoir envoyé au canal 1001');
  assert.ok(sentMessages.some(m => m.chatId === -1001003), 'Doit avoir envoyé au groupe 1003');
  assert.equal(sentMessages.some(m => m.chatId === -1001002), false, 'Le canal 1002 a échoué');

  // Le canal 1002 a été expulsé -> auto-retiré de la base
  assert.equal(db.getManagedChats().some(c => c.id === -1001002), false, 'Le canal mort doit être retiré');

  // Rapport de diffusion
  assert.ok(broadcastReplyReport.includes('RAPPORT DE DIFFUSION'), 'Doit générer un rapport de diffusion');
  assert.ok(broadcastReplyReport.includes('Canal News Télé-Réalité'), 'Le rapport doit mentionner le canal réussi');
  assert.ok(broadcastReplyReport.includes('Échecs'), 'Le rapport doit mentionner les échecs');

  // Nettoyage manuel
  db.removeManagedChat(-1001001);
  db.removeManagedChat(-1001003);
  assert.equal(db.getManagedChats().some(c => c.id === -1001001), false);
});

test.after(() => {
  const files = [
    'data/test_moderation_db.json',
    'data/test_shows_catalog.json'
  ];
  files.forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  try {
    if (fs.existsSync('data/test_backups')) {
      fs.rmSync('data/test_backups', { recursive: true, force: true });
    }
  } catch {}
});



