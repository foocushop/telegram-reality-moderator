import { config } from '../config.js';

export class FloodProtector {
  // Map<userId, number[]> timestamps of recent messages
  static userTimestamps = new Map();

  /**
   * Vérifie si un utilisateur est en train de flooder le chat
   * @param {number} userId 
   * @returns {{ isFlooding: boolean, count: number }}
   */
  static checkFlood(userId) {
    if (!config.antiFloodEnabled || !userId) {
      return { isFlooding: false, count: 0 };
    }

    const now = Date.now();
    const windowMs = (config.floodWindowSeconds || 4) * 1000;
    const maxMessages = config.floodMaxMessages || 5;

    let timestamps = this.userTimestamps.get(userId) || [];
    // Garder seulement les timestamps dans la fenêtre courante
    timestamps = timestamps.filter(t => (now - t) < windowMs);
    timestamps.push(now);
    this.userTimestamps.set(userId, timestamps);

    // Nettoyage régulier pour éviter les fuites de mémoire
    if (this.userTimestamps.size > 1000) {
      for (const [uid, list] of this.userTimestamps.entries()) {
        if (list.length === 0 || (now - list[list.length - 1]) > windowMs * 2) {
          this.userTimestamps.delete(uid);
        }
      }
    }

    if (timestamps.length >= maxMessages) {
      // Réinitialiser pour éviter de sanctionner en boucle infinie
      this.userTimestamps.delete(userId);
      return { isFlooding: true, count: timestamps.length };
    }

    return { isFlooding: false, count: timestamps.length };
  }

  static reset(userId) {
    if (userId) {
      this.userTimestamps.delete(userId);
    } else {
      this.userTimestamps.clear();
    }
  }
}
