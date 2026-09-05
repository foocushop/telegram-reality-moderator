export class ConversationSessionManager {
  constructor(ttlMs = 2 * 60 * 60 * 1000) { // 2 heures d'inactivité avant reset
    this.sessions = new Map();
    this.ttlMs = ttlMs;
  }

  getSession(userId) {
    const id = String(userId);
    let session = this.sessions.get(id);
    const now = Date.now();

    if (!session || (now - session.lastActivity > this.ttlMs)) {
      session = {
        messages: [],
        realityTvMentionCount: 0,
        lastActivity: now
      };
      this.sessions.set(id, session);
    } else {
      session.lastActivity = now;
    }

    return session;
  }

  addMessage(userId, role, content) {
    if (!content) return;
    const session = this.getSession(userId);
    session.messages.push({ role, content });
    // Conserver un historique fluide et économique des 6 derniers messages (3 échanges)
    if (session.messages.length > 6) {
      session.messages.shift();
    }
    session.lastActivity = Date.now();
  }

  getHistory(userId) {
    const session = this.getSession(userId);
    return session.messages;
  }

  getMentionCount(userId) {
    const session = this.getSession(userId);
    return session.realityTvMentionCount || 0;
  }

  incrementMentionCount(userId) {
    const session = this.getSession(userId);
    session.realityTvMentionCount = (session.realityTvMentionCount || 0) + 1;
  }

  // --- Gestion de la fréquence des mimiques (1 fois tous les 10 à 15 messages) ---
  shouldAllowMimicry(userId, threshold = 12) {
    const session = this.getSession(userId);
    return (session.messagesSinceMimicry || 0) >= threshold;
  }

  recordTurn(userId, usedMimicry = false) {
    const session = this.getSession(userId);
    if (usedMimicry) {
      session.messagesSinceMimicry = 0;
    } else {
      session.messagesSinceMimicry = (session.messagesSinceMimicry || 0) + 1;
    }
  }

  // Compteur global pour les messages du groupe
  groupMessagesSinceMimicry = 0;

  shouldAllowGroupMimicry(threshold = 12) {
    return this.groupMessagesSinceMimicry >= threshold;
  }

  recordGroupTurn(usedMimicry = false) {
    if (usedMimicry) {
      this.groupMessagesSinceMimicry = 0;
    } else {
      this.groupMessagesSinceMimicry++;
    }
  }

  resetSession(userId) {
    this.sessions.delete(String(userId));
  }
}

export const conversationSessions = new ConversationSessionManager();
