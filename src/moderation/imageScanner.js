import { config } from '../config.js';
import { geminiService } from '../ai/gemini.js';
import { ActionManager } from './actionManager.js';
import { db } from '../storage/database.js';

export class ImageScanner {
  /**
   * Analyse et modère les images envoyées dans le groupe
   * @param {import('grammy').Context} ctx 
   * @param {boolean} isImmune L'utilisateur est-il immunisé (Admin / Propriétaire / Maître) ?
   */
  static async scanMessage(ctx, isImmune = false) {
    // Vérifier si le message contient une photo ou un document image
    const photos = ctx.message?.photo;
    const document = ctx.message?.document;
    const isImageDoc = Boolean(document && document.mime_type && document.mime_type.startsWith('image/'));

    if (!photos && !isImageDoc) {
      return { handled: false };
    }

    db.incrementImageCount();

    const user = ctx.from;
    const userId = user.id;
    const userDetails = {
      username: user.username,
      fullName: [user.first_name, user.last_name].filter(Boolean).join(' ')
    };

    const senderDisplay = userDetails.username ? `@${userDetails.username}` : (userDetails.fullName || `ID:${userId}`);
    const mediaType = isImageDoc 
      ? `Fichier Document Image (${document.file_name || document.mime_type})` 
      : `Photo Telegram (${photos.length} résolution(s))`;
    const immunityLabel = isImmune 
      ? '🛡️ OUI (Administrateur / Propriétaire / Maître)' 
      : '👤 NON (Membre standard)';

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log(`📸 [SCANNER IMAGE] NOUVEAU MÉDIA VISUEL DÉTECTÉ DANS LE GROUPE`);
    console.log(`👤 Expéditeur   : ${senderDisplay} (ID: ${userId})`);
    console.log(`🛡️ Statut       : ${immunityLabel}`);
    console.log(`📁 Type Média   : ${mediaType}`);
    console.log('───────────────────────────────────────────────────────────────────');

    try {
      // 1. Récupérer le fichier auprès de Telegram (résolution intermédiaire ~320px pour diviser les tokens par 5)
      console.log(`[SCANNER IMAGE] 📥 1/3 Récupération de l'URL auprès de Telegram...`);
      let file = null;
      if (photos && photos.length > 1 && ctx.api && typeof ctx.api.getFile === 'function') {
        const targetPhoto = photos[1];
        file = await ctx.api.getFile(targetPhoto.file_id).catch(() => null);
      }
      if (!file) {
        file = await ctx.getFile();
      }
      if (!file.file_path) {
        console.warn('[SCANNER IMAGE] ⚠️ Impossible de récupérer le file_path Telegram.');
        console.log('═══════════════════════════════════════════════════════════════════\n');
        return { handled: false };
      }

      // 2. Téléchargement direct en mémoire vive (Buffer)
      console.log(`[SCANNER IMAGE] 📥 2/3 Téléchargement direct en mémoire RAM...`);
      const downloadUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        console.error(`[SCANNER IMAGE] ❌ Erreur HTTP lors du téléchargement: ${response.status} ${response.statusText}`);
        console.log('═══════════════════════════════════════════════════════════════════\n');
        return { handled: false };
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = isImageDoc ? document.mime_type : 'image/jpeg';
      const sizeKo = (arrayBuffer.byteLength / 1024).toFixed(1);

      console.log(`[SCANNER IMAGE] ⚡ 3/3 Image chargée (${sizeKo} Ko) - Envoi à l'IA Vision en cours...`);

      // 3. Analyse Vision IA avec Groq / Gemini
      const analysis = await geminiService.analyzeImage(base64Data, mimeType);

      console.log(`[SCANNER IMAGE] 📊 VERDICT IA :`);
      console.log(`  • Modèle utilisé      : ${analysis.modelUsed || 'Vision'}`);
      console.log(`  • Contenu Adulte/NSFW  : ${analysis.isAdultNsfw ? '🚨 OUI (DÉTECTÉ)' : '✅ NON'}`);
      console.log(`  • Inapproprié         : ${analysis.isInappropriate ? '⚠️ OUI' : '✅ NON'}`);
      console.log(`  • Gravité (Severity)  : ${analysis.severity}`);
      console.log(`  • Action recommandée  : ${analysis.action}`);
      console.log(`  • Motif / Raison      : "${analysis.reason}"`);

      // 4. Décision & Sanction
      if (analysis.isAdultNsfw || analysis.action === 'ban' || analysis.severity === 'severe') {
        const reason = analysis.reason || "Contenu pour adulte (NSFW), pornographie ou image violente interdite.";

        if (isImmune) {
          console.log(`[SCANNER IMAGE] 🛡️ IMMUNITÉ APPLIQUÉE : ${senderDisplay} est Administrateur/Propriétaire/Maître.`);
          console.log(`[SCANNER IMAGE] 🚫 AUCUN BANNISSEMENT appliqué pour protéger vos droits administrateurs.`);
          
          if (config.deleteOffendingMessages) {
            await ctx.deleteMessage().catch(() => {});
            console.log(`[SCANNER IMAGE] 🗑️ Photo NSFW supprimée du groupe (pour préserver la propreté du canal).`);
          }
          console.log(`[SCANNER IMAGE] 💡 CONSEIL TEST : Pour tester le BANNISSEMENT RÉEL automatique, postez l'image depuis un compte Telegram secondaire NON-ADMINISTRATEUR.`);
          console.log('═══════════════════════════════════════════════════════════════════\n');
          return { handled: true, action: 'immune_deleted', reason };
        }

        console.log(`[SCANNER IMAGE] 🚨 ACTION SANCTION : Membre standard non-immunisé -> BAN DÉFINITIF EN COURS...`);
        await ActionManager.executeBan(ctx, userId, userDetails, reason);
        console.log(`[SCANNER IMAGE] 🚫 Utilisateur ${senderDisplay} banni avec succès.`);
        console.log('═══════════════════════════════════════════════════════════════════\n');
        return { handled: true, action: 'ban', reason };
      }

      if (analysis.action === 'delete') {
        console.log(`[SCANNER IMAGE] 🗑️ Suppression de l'image demandée par l'IA : ${analysis.reason}`);
        if (config.deleteOffendingMessages) {
          await ctx.deleteMessage().catch(() => {});
        }
        console.log('═══════════════════════════════════════════════════════════════════\n');
        return { handled: true, action: 'delete', reason: analysis.reason };
      }

      // Image conforme
      console.log(`[SCANNER IMAGE] ✅ Image saine et conforme aux règles du groupe.`);
      console.log('═══════════════════════════════════════════════════════════════════\n');
      return { handled: false };
    } catch (err) {
      console.error('[SCANNER IMAGE] ❌ Erreur lors du traitement de l\'image:', err.message);
      console.log('═══════════════════════════════════════════════════════════════════\n');
      return { handled: false };
    }
  }
}
