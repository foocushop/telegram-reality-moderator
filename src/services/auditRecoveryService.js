import { db } from '../storage/database.js';
import { CloudSyncService } from './cloudSyncService.js';

/**
 * Service de récupération des utilisateurs historiques depuis le canal d'audit
 * Analyse les exports JSON/texte ou messages transférés et réinjecte tous les membres.
 */
export class AuditRecoveryService {
  /**
   * Analyse n'importe quel contenu textuel ou export JSON pour en extraire les utilisateurs
   */
  static parseUsers(content) {
    if (!content) return [];
    const usersMap = new Map();

    let textContent = '';

    // Si c'est un objet ou du JSON Telegram Desktop
    if (typeof content === 'object') {
      this._extractFromParsedObject(content, usersMap);
      textContent = JSON.stringify(content);
    } else if (typeof content === 'string') {
      textContent = content;
      // Essayer de parser en JSON au cas où c'est un export Telegram Desktop (result.json)
      if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(content);
          this._extractFromParsedObject(parsed, usersMap);
        } catch (e) {
          // Si ce n'est pas du JSON valide, on traite comme du texte brut
        }
      }
    }

    // 1. Format Telegram Audit Message
    // Membre : Nom (@username | ID) ou <b>Membre :</b> <b>Nom</b> (@username | <code>ID</code>)
    const auditPattern = /Membre\s*:\s*(?:<\/b>)?\s*(?:<b>)?([^<\n\r()|]+)?(?:<\/b>)?\s*\((?:@([a-zA-Z0-9_]+)\s*\|?\s*)?(?:<code>)?(\d{6,12})(?:<\/code>)?\)/gi;
    let m;
    while ((m = auditPattern.exec(textContent)) !== null) {
      const fullName = (m[1] || '').replace(/<[^>]*>/g, '').trim() || 'Membre';
      const username = (m[2] || '').trim();
      const userId = Number(m[3]);
      if (userId) {
        const existing = usersMap.get(userId) || {};
        usersMap.set(userId, {
          userId,
          username: username || existing.username || '',
          fullName: fullName !== 'Membre' ? fullName : (existing.fullName || 'Membre')
        });
      }
    }

    // 2. Format Console Render Logs
    // De : @username (Nom) [ID: 123456789] ou De : Nom [ID: 123456789]
    const consolePattern = /(?:De|À|Destinataire|Expéditeur)\s*:\s*(?:@([a-zA-Z0-9_]+))?\s*(?:\(([^)\n\r]+)\))?\s*\[ID:\s*(\d{6,12})\]/gi;
    while ((m = consolePattern.exec(textContent)) !== null) {
      const username = (m[1] || '').trim();
      const fullName = (m[2] || '').trim() || 'Membre';
      const userId = Number(m[3]);
      if (userId) {
        const existing = usersMap.get(userId) || {};
        usersMap.set(userId, {
          userId,
          username: username || existing.username || '',
          fullName: fullName !== 'Membre' ? fullName : (existing.fullName || 'Membre')
        });
      }
    }

    // 3. Format générique ID Telegram explicite
    const genericIdPattern = /(?:\[ID:\s*|ID:\s*|<code>|ID\s*:\s*)(\d{6,12})(?:\]|<\/code>)?/gi;
    while ((m = genericIdPattern.exec(textContent)) !== null) {
      const userId = Number(m[1]);
      if (userId && !usersMap.has(userId)) {
        usersMap.set(userId, { userId, username: '', fullName: 'Membre' });
      }
    }

    return Array.from(usersMap.values());
  }

  /**
   * Extrait les utilisateurs depuis un objet JSON parsé (ex: export Telegram Desktop result.json)
   * @private
   */
  static _extractFromParsedObject(obj, usersMap) {
    if (!obj || typeof obj !== 'object') return;

    // Format export Telegram Desktop: { messages: [ { text: "...", ... } ] }
    if (Array.isArray(obj.messages)) {
      for (const msg of obj.messages) {
        // Si text est un tableau de chaînes ou d'entités de mise en forme
        let msgText = '';
        if (typeof msg.text === 'string') {
          msgText = msg.text;
        } else if (Array.isArray(msg.text)) {
          msgText = msg.text.map(t => (typeof t === 'string' ? t : (t?.text || ''))).join('');
        }

        if (msgText) {
          // Récursion locale sur le texte du message
          const found = this.parseUsers(msgText);
          for (const u of found) {
            usersMap.set(u.userId, u);
          }
        }

        // Si le message contient directement un from_id utilisateur
        if (msg.from_id && typeof msg.from_id === 'string' && msg.from_id.startsWith('user')) {
          const uId = Number(msg.from_id.replace('user', ''));
          if (uId && !usersMap.has(uId)) {
            usersMap.set(uId, { userId: uId, username: '', fullName: msg.from || 'Membre' });
          }
        }
      }
    }

    // Format liste directe d'utilisateurs: [ { userId: 123 }, ... ]
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const id = item?.userId || item?.id;
        if (id && Number(id)) {
          const numId = Number(id);
          usersMap.set(numId, {
            userId: numId,
            username: item.username || '',
            fullName: item.first_name || item.fullName || 'Membre'
          });
        }
      }
    }
  }

  /**
   * Injecte une liste d'utilisateurs récupérés dans la base et lance la sauvegarde Cloud
   */
  static async injectRecoveredUsers(users, api = null) {
    if (!Array.isArray(users) || users.length === 0) {
      return { injectedCount: 0, totalUsers: db.getPrivateUsers().length };
    }

    let injectedCount = 0;
    for (const u of users) {
      if (u && u.userId) {
        db.savePrivateUser({
          id: u.userId,
          username: u.username || null,
          first_name: u.fullName || 'Membre'
        });
        injectedCount++;
      }
    }

    db.save();

    // Si l'API est fournie, déclencher immédiatement la sauvegarde Cloud et l'épinglage
    if (api) {
      await CloudSyncService.saveToCloud(api, 'recovered_audit_users');
    }

    return {
      injectedCount,
      totalUsers: db.getPrivateUsers().length,
      knownUsersCount: Object.keys(db.data.knownUsers || {}).length
    };
  }
}
