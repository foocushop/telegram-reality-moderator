import fs from 'fs';
import path from 'path';

const DB_DIR = path.resolve('data');
const isTestEnv = process.env.NODE_ENV === 'test' ||
  process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test')));

const DB_FILE = isTestEnv
  ? path.join(DB_DIR, 'test_moderation_db.json')
  : (process.env.DB_FILE_PATH || path.join(DB_DIR, 'moderation_db.json'));

const SHOWS_FILE = isTestEnv
  ? path.join(DB_DIR, 'test_shows_catalog.json')
  : (process.env.SHOWS_FILE_PATH || path.join(DB_DIR, 'shows_catalog.json'));

const BACKUPS_DIR = path.join(DB_DIR, isTestEnv ? 'test_backups' : 'backups');

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const cleanContent = content.replace(/^\uFEFF/, '').trim();
    if (!cleanContent) return null;
    return JSON.parse(cleanContent);
  } catch (err) {
    console.error(`[DATABASE] Erreur de lecture JSON (${path.basename(filePath)}):`, err.message);
    return null;
  }
}

export class ModerationDatabase {
  constructor() {
    this.data = {
      bannedUsers: {}, // { [userId]: { userId, username, reason, bannedAt, chatId } }
      mutedUsers: {},  // { [userId]: { userId, username, reason, mutedAt, unmuteAt, chatId } }
      infractions: {}, // { [userId]: [ { date, type, reason } ] }
      warnings: {},    // { [userId]: [ { date, reason, by } ] }
      mainGroupId: null, // ID du groupe Telegram principal géré
      auditChannelId: null, // ID du canal Telegram dédié à l'audit des chats privés
      ownerId: null,     // ID Telegram du propriétaire du groupe
      masterUsername: null, // @username du Maître / Dieu suprême du bot (legacy/principal)
      masterId: null,       // ID Telegram du Maître suprême (legacy/principal)
      masters: [],          // Liste des Maîtres Suprêmes [{ username, id, addedAt }]
      managedChats: [],     // Liste des canaux et groupes gérés [{ id, title, type, username, addedAt }]
      adminIds: [],      // Liste des IDs des administrateurs du groupe
      shows: {},         // { [showId]: { id, name, link, description, aliases, addedAt } }
      privateUsers: {},  // { [userId]: { userId, username, fullName, lastSeen } }
      stats: {
        messagesScanned: 0,
        imagesScanned: 0,
        bansCount: 0,
        mutesCount: 0,
        floodIntercepted: 0,
        linksBlocked: 0,
        startedAt: new Date().toISOString()
      }
    };
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
      }
      if (!fs.existsSync(BACKUPS_DIR)) {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      }

      // Seeding initial si le volume persistant est vide (ex: premier déploiement cloud Fly.io)
      if (!isTestEnv) {
        const defaultDbPath = path.resolve('defaults/moderation_db.json');
        const defaultShowsPath = path.resolve('defaults/shows_catalog.json');
        if (!fs.existsSync(DB_FILE) && fs.existsSync(defaultDbPath)) {
          try {
            fs.copyFileSync(defaultDbPath, DB_FILE);
            console.log('[DATABASE] 📦 Volume persistant initialisé depuis defaults/moderation_db.json.');
          } catch (e) {}
        }
        if (!fs.existsSync(SHOWS_FILE) && fs.existsSync(defaultShowsPath)) {
          try {
            fs.copyFileSync(defaultShowsPath, SHOWS_FILE);
            console.log('[DATABASE] 📦 Catalogue persistant initialisé depuis defaults/shows_catalog.json.');
          } catch (e) {}
        }
      }

      // 1. Charger le fichier principal
      const parsed = safeReadJson(DB_FILE);
      if (parsed) {
        this.data = {
          ...this.data,
          ...parsed,
          shows: parsed.shows || {},
          masters: Array.isArray(parsed.masters) ? parsed.masters : [],
          managedChats: Array.isArray(parsed.managedChats) ? parsed.managedChats : []
        };
      } else if (fs.existsSync(DB_FILE)) {
        console.error('[DATABASE] Erreur lecture DB principale, tentative de récupération...');
        this.restoreFromLatestBackup();
      }

      if (!this.data.shows) this.data.shows = {};
      if (!Array.isArray(this.data.masters)) this.data.masters = [];
      if (!Array.isArray(this.data.managedChats)) this.data.managedChats = [];
      if (!this.data.privateUsers || typeof this.data.privateUsers !== 'object') this.data.privateUsers = {};

      // Synchronisation initiale automatique : si privateUsers est vide mais que knownUsers a des membres
      if (Object.keys(this.data.privateUsers).length === 0 && this.data.knownUsers && Object.keys(this.data.knownUsers).length > 0) {
        this.syncKnownUsersToPrivate();
      }

      // Migration automatique : si masters est vide mais qu'un master historique existe
      if (this.data.masters.length === 0 && (this.data.masterUsername || this.data.masterId)) {
        this.data.masters.push({
          username: this.data.masterUsername || null,
          id: this.data.masterId || null,
          addedAt: new Date().toISOString()
        });
      }

      // 2. Synchronisation croisée et restauration automatique des émissions
      this.syncShowsCatalogOnInit();

      // 3. Sauvegarder la base et le catalogue miroir
      this.save();
      this.saveShowsCatalog();

      // 4. Snapshot initial au démarrage si des séries existent
      const showsCount = Object.keys(this.data.shows).length;
      if (showsCount > 0 && !isTestEnv) {
        this.createBackup('Démarrage et synchronisation initiale');
      }
    } catch (err) {
      console.error('[DATABASE] Erreur lors de l\'initialisation de la base:', err);
    }
  }

  syncShowsCatalogOnInit() {
    const dbShowsCount = Object.keys(this.data.shows || {}).length;

    // A. Vérifier le catalogue dédié shows_catalog.json
    const catalog = safeReadJson(SHOWS_FILE);
    if (catalog) {
      try {
        const catalogShows = catalog.shows || catalog;
        const catalogCount = Object.keys(catalogShows || {}).length;

        // Si la DB n'a aucune émission mais que shows_catalog.json en a -> Restauration automatique
        if (dbShowsCount === 0 && catalogCount > 0) {
          console.log(`[DATABASE] 🔄 Restauration automatique de ${catalogCount} séries depuis ${path.basename(SHOWS_FILE)}`);
          this.data.shows = { ...catalogShows };
          return;
        }

        // Si les deux fichiers ont des séries, fusionner pour ne rien perdre
        if (catalogCount > 0) {
          for (const [id, show] of Object.entries(catalogShows)) {
            if (!this.data.shows[id]) {
              this.data.shows[id] = show;
            }
          }
        }
      } catch (err) {
        console.error('[DATABASE] Erreur lors de la synchronisation du catalogue:', err.message);
      }
    }

    // B. Si toujours aucune série, tenter une restauration depuis un backup historique
    if (Object.keys(this.data.shows || {}).length === 0 && !isTestEnv) {
      this.restoreFromLatestBackup();
    }
  }

  save() {
    try {
      if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
      }
      const tmpFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
      console.error('[DATABASE] Erreur lors de la sauvegarde:', err);
    }
  }

  saveShowsCatalog() {
    try {
      if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
      }
      const payload = {
        updatedAt: new Date().toISOString(),
        totalShows: Object.keys(this.data.shows || {}).length,
        shows: this.data.shows || {}
      };
      const tmpFile = `${SHOWS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmpFile, SHOWS_FILE);
    } catch (err) {
      console.error('[DATABASE] Erreur lors de la sauvegarde du catalogue de séries:', err);
    }
  }

  createBackup(reason = 'Manuel') {
    try {
      if (!fs.existsSync(BACKUPS_DIR)) {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      }

      const now = new Date();
      const dateSlug = now.toISOString().replace(/[:.]/g, '-');
      const backupFilename = `backup_${dateSlug}.json`;
      const backupPath = path.join(BACKUPS_DIR, backupFilename);

      const backupData = {
        version: '2.0',
        timestamp: now.toISOString(),
        reason,
        showsCount: Object.keys(this.data.shows || {}).length,
        stats: this.data.stats,
        ownerId: this.data.ownerId,
        mainGroupId: this.data.mainGroupId,
        adminIds: this.data.adminIds,
        shows: this.data.shows || {},
        bannedUsers: this.data.bannedUsers || {},
        mutedUsers: this.data.mutedUsers || {}
      };

      // Fichier d'archive horodaté
      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

      // Fichier miroir "latest"
      const latestPath = path.join(BACKUPS_DIR, 'latest_backup.json');
      fs.writeFileSync(latestPath, JSON.stringify(backupData, null, 2), 'utf-8');

      // Conserver les 10 dernières sauvegardes horodatées
      this.rotateBackups();

      return {
        filename: backupFilename,
        path: backupPath,
        timestamp: now.toISOString(),
        showsCount: backupData.showsCount
      };
    } catch (err) {
      console.error('[DATABASE] Erreur création de sauvegarde:', err);
      return null;
    }
  }

  rotateBackups(maxKeep = 10) {
    try {
      if (!fs.existsSync(BACKUPS_DIR)) return;
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort();

      if (files.length > maxKeep) {
        const toDelete = files.slice(0, files.length - maxKeep);
        for (const file of toDelete) {
          try {
            fs.unlinkSync(path.join(BACKUPS_DIR, file));
          } catch {}
        }
      }
    } catch (err) {
      console.error('[DATABASE] Erreur rotation des sauvegardes:', err.message);
    }
  }

  restoreFromLatestBackup() {
    try {
      if (!fs.existsSync(BACKUPS_DIR)) return false;

      let targetBackup = path.join(BACKUPS_DIR, 'latest_backup.json');
      if (!fs.existsSync(targetBackup)) {
        const files = fs.readdirSync(BACKUPS_DIR)
          .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
          .sort()
          .reverse();
        if (files.length > 0) {
          targetBackup = path.join(BACKUPS_DIR, files[0]);
        } else {
          return false;
        }
      }

      const backup = safeReadJson(targetBackup);
      if (backup && backup.shows && Object.keys(backup.shows).length > 0) {
        this.data.shows = { ...backup.shows };
        console.log(`[DATABASE] 💾 ${Object.keys(backup.shows).length} séries restaurées avec succès depuis ${path.basename(targetBackup)} !`);
        this.save();
        this.saveShowsCatalog();
        return true;
      }
    } catch (err) {
      console.error('[DATABASE] Erreur lors de la restauration depuis le backup:', err.message);
    }
    return false;
  }

  listBackups() {
    try {
      if (!fs.existsSync(BACKUPS_DIR)) return [];
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort()
        .reverse();

      return files.map(file => {
        const parsed = safeReadJson(path.join(BACKUPS_DIR, file));
        if (parsed) {
          return {
            filename: file,
            timestamp: parsed.timestamp || '',
            reason: parsed.reason || 'Automatique',
            showsCount: parsed.showsCount || (parsed.shows ? Object.keys(parsed.shows).length : 0)
          };
        }
        return { filename: file, timestamp: 'Inconnue', reason: 'Fichier archive', showsCount: 0 };
      });
    } catch {
      return [];
    }
  }

  // --- Gestion des bannissements ---
  addBannedUser(userId, info) {
    this.data.bannedUsers[userId] = {
      userId,
      username: info.username || 'Inconnu',
      fullName: info.fullName || '',
      reason: info.reason || 'Violation grave des règles',
      chatId: info.chatId,
      bannedAt: new Date().toISOString()
    };
    this.data.stats.bansCount = (this.data.stats.bansCount || 0) + 1;
    this.recordInfraction(userId, 'ban', info.reason);
    this.save();
  }

  removeBannedUser(userId) {
    if (this.data.bannedUsers[userId]) {
      delete this.data.bannedUsers[userId];
      this.save();
      return true;
    }
    return false;
  }

  isUserBanned(userId) {
    return Boolean(this.data.bannedUsers[userId]);
  }

  getBannedUser(userId) {
    return this.data.bannedUsers[userId] || null;
  }

  // --- Gestion des mutes (mise en sourdine) ---
  addMutedUser(userId, info, durationMinutes) {
    const mutedAt = Date.now();
    const unmuteAt = mutedAt + (durationMinutes * 60 * 1000);

    this.data.mutedUsers[userId] = {
      userId,
      username: info.username || 'Inconnu',
      fullName: info.fullName || '',
      reason: info.reason || 'Insulte légère / vulgarité',
      chatId: info.chatId,
      mutedAt: new Date(mutedAt).toISOString(),
      unmuteAt: new Date(unmuteAt).toISOString(),
      unmuteTimestamp: unmuteAt
    };
    this.data.stats.mutesCount = (this.data.stats.mutesCount || 0) + 1;
    this.recordInfraction(userId, 'mute', info.reason);
    this.save();
  }

  removeMutedUser(userId) {
    if (this.data.mutedUsers[userId]) {
      delete this.data.mutedUsers[userId];
      this.save();
      return true;
    }
    return false;
  }

  isUserMuted(userId) {
    const muted = this.data.mutedUsers[userId];
    if (!muted) return false;
    if (Date.now() > muted.unmuteTimestamp) {
      // Expiré
      this.removeMutedUser(userId);
      return false;
    }
    return true;
  }

  // --- Historique des infractions ---
  recordInfraction(userId, type, reason) {
    if (!this.data.infractions[userId]) {
      this.data.infractions[userId] = [];
    }
    this.data.infractions[userId].push({
      date: new Date().toISOString(),
      type,
      reason
    });
  }

  // --- Gestion des avertissements (Warns) ---
  addWarning(userId, info, reason) {
    if (!this.data.warnings) this.data.warnings = {};
    if (!this.data.warnings[userId]) {
      this.data.warnings[userId] = [];
    }
    this.data.warnings[userId].push({
      date: new Date().toISOString(),
      reason: reason || 'Non-respect des règles',
      by: info.by || 'Modérateur'
    });
    this.recordInfraction(userId, 'warning', reason);
    this.save();
    return this.data.warnings[userId].length;
  }

  getWarnings(userId) {
    return (this.data.warnings && this.data.warnings[userId]) || [];
  }

  clearWarnings(userId) {
    if (this.data.warnings && this.data.warnings[userId]) {
      delete this.data.warnings[userId];
      this.save();
      return true;
    }
    return false;
  }

  getUserInfractionsCount(userId) {
    return (this.data.infractions[userId] || []).length;
  }

  // --- Statistiques d'analyse ---
  incrementMessageCount() {
    this.data.stats.messagesScanned = (this.data.stats.messagesScanned || 0) + 1;
    if (this.data.stats.messagesScanned % 20 === 0) {
      this.save();
    }
  }

  incrementImageCount() {
    this.data.stats.imagesScanned = (this.data.stats.imagesScanned || 0) + 1;
    this.save();
  }

  incrementFloodCount() {
    this.data.stats.floodIntercepted = (this.data.stats.floodIntercepted || 0) + 1;
    this.save();
  }

  incrementLinkBlockedCount() {
    this.data.stats.linksBlocked = (this.data.stats.linksBlocked || 0) + 1;
    this.save();
  }

  // --- Enregistrement et résolution par @username ---
  saveUser(userId, info) {
    if (!this.data.knownUsers) this.data.knownUsers = {};
    if (!this.data.usernameToId) this.data.usernameToId = {};

    const rawUsername = info.username || '';
    const cleanUsername = rawUsername.toLowerCase().replace(/^@/, '').trim();

    this.data.knownUsers[userId] = {
      userId,
      username: rawUsername,
      fullName: info.fullName || '',
      lastSeen: new Date().toISOString()
    };

    if (cleanUsername) {
      this.data.usernameToId[cleanUsername] = userId;
    }
  }

  getUserIdByUsername(username) {
    if (!username) return null;
    const clean = username.toLowerCase().replace(/^@/, '').trim();

    if (this.data.usernameToId && this.data.usernameToId[clean]) {
      return this.data.usernameToId[clean];
    }

    for (const [id, u] of Object.entries(this.data.knownUsers || {})) {
      if (u.username && u.username.toLowerCase().replace(/^@/, '').trim() === clean) {
        return Number(id);
      }
    }

    for (const [id, u] of Object.entries(this.data.bannedUsers || {})) {
      if (u.username && u.username.toLowerCase().replace(/^@/, '').trim() === clean) {
        return Number(id);
      }
    }

    for (const [id, u] of Object.entries(this.data.mutedUsers || {})) {
      if (u.username && u.username.toLowerCase().replace(/^@/, '').trim() === clean) {
        return Number(id);
      }
    }

    for (const [id, u] of Object.entries(this.data.privateUsers || {})) {
      if (u.username && u.username.toLowerCase().replace(/^@/, '').trim() === clean) {
        return Number(id);
      }
    }

    return null;
  }

  getUserDetails(userId) {
    return (this.data.knownUsers && this.data.knownUsers[userId]) ||
           (this.data.bannedUsers && this.data.bannedUsers[userId]) ||
           (this.data.mutedUsers && this.data.mutedUsers[userId]) ||
           (this.data.privateUsers && this.data.privateUsers[userId]) ||
           null;
  }

  // --- Gestion des Utilisateurs Privés (Pour broadcast MP et messages ciblés) ---
  savePrivateUser(user) {
    if (!user || !user.id) return null;
    if (!this.data.privateUsers) this.data.privateUsers = {};
    const userId = Number(user.id);
    const rawUsername = user.username ? String(user.username).replace(/^@/, '').trim() : '';
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Utilisateur';

    this.data.privateUsers[userId] = {
      userId,
      username: rawUsername,
      fullName,
      isReachable: true,
      lastInteraction: new Date().toISOString()
    };

    // Mémoriser également dans knownUsers et le mapping d'identifiants
    this.saveUser(userId, { username: rawUsername, fullName });
    this.save();
    return this.data.privateUsers[userId];
  }

  getPrivateUsers(onlyReachable = false) {
    if (!this.data.privateUsers) this.data.privateUsers = {};
    const all = Object.values(this.data.privateUsers);
    if (onlyReachable) {
      return all.filter(u => u.isReachable !== false);
    }
    return all;
  }

  isPrivateUser(userId) {
    if (!userId || !this.data.privateUsers) return false;
    return Boolean(this.data.privateUsers[String(userId)] || this.data.privateUsers[Number(userId)]);
  }

  markPrivateUserReachable(userId, isReachable = true, errorReason = null) {
    if (!this.data.privateUsers || !userId) return;
    const strId = String(userId);
    const numId = Number(userId);
    const target = this.data.privateUsers[strId] || this.data.privateUsers[numId];
    if (target) {
      target.isReachable = isReachable;
      if (errorReason) target.lastError = errorReason;
      target.lastCheckedAt = new Date().toISOString();
      this.save();
    }
  }

  getStorageChatId() {
    return process.env.STORAGE_CHAT_ID ||
           process.env.BACKUP_CHANNEL_ID ||
           this.data.storageChatId ||
           this.data.auditChannelId ||
           process.env.AUDIT_CHANNEL_ID ||
           this.data.ownerId ||
           (process.env.ADMIN_USER_IDS ? Number(process.env.ADMIN_USER_IDS.split(',')[0].trim()) : null);
  }

  setStorageChatId(chatId) {
    if (!chatId) return false;
    this.data.storageChatId = Number(chatId);
    this.save();
    return true;
  }

  removePrivateUser(userId) {
    if (!this.data.privateUsers || !userId) return false;
    const strId = String(userId);
    const numId = Number(userId);
    let deleted = false;
    if (this.data.privateUsers[strId]) {
      delete this.data.privateUsers[strId];
      deleted = true;
    }
    if (this.data.privateUsers[numId]) {
      delete this.data.privateUsers[numId];
      deleted = true;
    }
    if (deleted) this.save();
    return deleted;
  }

  /**
   * Synchronise les utilisateurs historiques connus vers la liste d'envoi privé
   */
  syncKnownUsersToPrivate() {
    if (!this.data.privateUsers) this.data.privateUsers = {};
    let addedCount = 0;
    for (const [userId, user] of Object.entries(this.data.knownUsers || {})) {
      const strId = String(userId);
      const numId = Number(userId);
      if (!this.data.privateUsers[strId] && !this.data.privateUsers[numId]) {
        this.data.privateUsers[strId] = {
          userId: numId,
          username: user.username || '',
          fullName: user.fullName || 'Utilisateur',
          lastInteraction: user.lastSeen || new Date().toISOString(),
          fromSync: true
        };
        addedCount++;
      }
    }
    if (addedCount > 0) {
      this.save();
      console.log(`[DATABASE] 👥 ${addedCount} utilisateur(s) historique(s) synchronisé(s) vers les destinataires privés.`);
    }
    return addedCount;
  }

  getStats() {
    return {
      ...this.data.stats,
      activeBans: Object.keys(this.data.bannedUsers).length,
      activeMutes: Object.keys(this.data.mutedUsers).length
    };
  }

  // --- Gestion des Canaux & Groupes Multiples (Multi-Destination Broadcast) ---
  addManagedChat(chatId, title = 'Canal / Groupe', type = 'channel', username = null) {
    if (!chatId) return false;
    const numId = Number(chatId);
    if (!Array.isArray(this.data.managedChats)) {
      this.data.managedChats = [];
    }

    const existingIndex = this.data.managedChats.findIndex(c => Number(c.id) === numId);
    const chatData = {
      id: numId,
      title: title || (type === 'channel' ? 'Canal sans titre' : 'Groupe sans titre'),
      type: type || 'channel',
      username: username ? String(username).replace(/^@/, '') : null,
      addedAt: existingIndex >= 0 ? this.data.managedChats[existingIndex].addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      this.data.managedChats[existingIndex] = { ...this.data.managedChats[existingIndex], ...chatData };
    } else {
      this.data.managedChats.push(chatData);
    }

    if (['group', 'supergroup'].includes(type) && !this.data.mainGroupId) {
      this.data.mainGroupId = numId;
    }

    this.save();
    return true;
  }

  removeManagedChat(chatId) {
    if (!chatId || !Array.isArray(this.data.managedChats)) return false;
    const numId = Number(chatId);
    const initialLen = this.data.managedChats.length;
    this.data.managedChats = this.data.managedChats.filter(c => Number(c.id) !== numId);

    if (this.data.mainGroupId === numId) {
      const remainingGroup = this.data.managedChats.find(c => ['group', 'supergroup'].includes(c.type));
      this.data.mainGroupId = remainingGroup ? remainingGroup.id : null;
    }

    if (this.data.managedChats.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  getManagedChats() {
    if (!Array.isArray(this.data.managedChats)) {
      this.data.managedChats = [];
    }
    // Migration à la volée si mainGroupId existe mais pas dans managedChats
    if (this.data.mainGroupId && !this.data.managedChats.some(c => Number(c.id) === Number(this.data.mainGroupId))) {
      this.data.managedChats.push({
        id: Number(this.data.mainGroupId),
        title: 'Groupe Principal',
        type: 'supergroup',
        username: null,
        addedAt: new Date().toISOString()
      });
      this.save();
    }
    return this.data.managedChats;
  }

  getManagedChannels() {
    return this.getManagedChats().filter(c => c.type === 'channel');
  }

  getManagedGroups() {
    return this.getManagedChats().filter(c => ['group', 'supergroup'].includes(c.type));
  }

  setMainGroupId(groupId, title = null, type = 'supergroup', username = null) {
    if (groupId) {
      const numId = Number(groupId);
      this.data.mainGroupId = numId;
      this.addManagedChat(numId, title || 'Groupe Télé-Réalité', type || 'supergroup', username);
    }
  }

  getMainGroupId() {
    return this.data.mainGroupId || null;
  }

  setOwnerId(ownerId) {
    if (ownerId && this.data.ownerId !== ownerId) {
      this.data.ownerId = ownerId;
      this.save();
    }
  }

  getOwnerId() {
    return this.data.ownerId || null;
  }

  // --- Gestion du Canal d'Audit Dédié (Surveillance des chats privés) ---
  setAuditChannelId(channelId) {
    this.data.auditChannelId = channelId ? String(channelId).trim() : null;
    this.save();
    return this.data.auditChannelId;
  }

  getAuditChannelId() {
    return this.data.auditChannelId || null;
  }

  getEffectiveAuditChannelId() {
    return this.data.auditChannelId || (process.env.AUDIT_CHANNEL_ID ? String(process.env.AUDIT_CHANNEL_ID).trim() : null) || null;
  }

  // --- Gestion des Maîtres Suprêmes / Dieux du Bot ---
  getMasters() {
    if (!Array.isArray(this.data.masters)) {
      this.data.masters = [];
    }
    // Migration à la volée si la liste est vide mais qu'un master historique existe
    if (this.data.masters.length === 0 && (this.data.masterUsername || this.data.masterId)) {
      this.data.masters.push({
        username: this.data.masterUsername || null,
        id: this.data.masterId || null,
        addedAt: new Date().toISOString()
      });
    }
    return this.data.masters;
  }

  addMaster(userOrString) {
    if (!userOrString) return null;

    let cleanUsername = null;
    let foundId = null;

    if (typeof userOrString === 'object') {
      const user = userOrString;
      if (user.id) foundId = Number(user.id);
      if (user.username) cleanUsername = user.username.toLowerCase().replace(/^@/, '').trim();
    } else {
      const str = String(userOrString).trim();
      if (!str) return null;

      if (/^\d+$/.test(str)) {
        foundId = Number(str);
        const details = this.getUserDetails(foundId);
        if (details && details.username) {
          cleanUsername = details.username.toLowerCase().replace(/^@/, '');
        }
      } else {
        cleanUsername = str.toLowerCase().replace(/^@/, '').trim();
        foundId = this.getUserIdByUsername(cleanUsername) || null;
      }
    }

    if (!cleanUsername && !foundId) return null;

    const masters = this.getMasters();
    const existingIndex = masters.findIndex(m =>
      (cleanUsername && m.username && m.username.toLowerCase() === cleanUsername) ||
      (foundId && m.id && m.id === foundId)
    );

    const masterObj = {
      username: cleanUsername || (existingIndex >= 0 ? masters[existingIndex].username : null),
      id: foundId || (existingIndex >= 0 ? masters[existingIndex].id : null),
      addedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      masters[existingIndex] = {
        ...masters[existingIndex],
        ...masterObj
      };
    } else {
      masters.push(masterObj);
    }

    // Synchronisation pour rétrocompatibilité
    this.data.masterUsername = masters[0]?.username || null;
    this.data.masterId = masters[0]?.id || null;

    if (foundId) {
      this.addAdminId(foundId);
    }

    this.save();
    if (!isTestEnv) {
      this.createBackup(`Ajout du Maître Suprême : ${cleanUsername ? '@' + cleanUsername : foundId}`);
    }
    return masterObj;
  }

  removeMaster(userOrString) {
    if (!userOrString) return false;

    let targetUsername = null;
    let targetId = null;

    if (typeof userOrString === 'object') {
      if (userOrString.id) targetId = Number(userOrString.id);
      if (userOrString.username) targetUsername = userOrString.username.toLowerCase().replace(/^@/, '').trim();
    } else {
      const str = String(userOrString).trim();
      if (/^\d+$/.test(str)) {
        targetId = Number(str);
      } else {
        targetUsername = str.toLowerCase().replace(/^@/, '').trim();
      }
    }

    const masters = this.getMasters();
    const initialLen = masters.length;

    this.data.masters = masters.filter(m => {
      if (targetId && m.id && m.id === targetId) return false;
      if (targetUsername && m.username && m.username.toLowerCase() === targetUsername) return false;
      return true;
    });

    const removed = this.data.masters.length < initialLen;
    if (removed) {
      this.data.masterUsername = this.data.masters[0]?.username || null;
      this.data.masterId = this.data.masters[0]?.id || null;
      this.save();
      if (!isTestEnv) {
        this.createBackup(`Suppression du Maître Suprême : ${targetUsername ? '@' + targetUsername : targetId}`);
      }
    }
    return removed;
  }

  setMaster(usernameOrId) {
    return this.addMaster(usernameOrId);
  }

  getMaster() {
    const masters = this.getMasters();
    if (masters.length > 0) {
      return {
        username: masters[0].username || null,
        id: masters[0].id || null
      };
    }
    return {
      username: this.data.masterUsername || null,
      id: this.data.masterId || null
    };
  }

  isMaster(userOrId) {
    if (!userOrId) return false;

    const masters = this.getMasters();

    // Cas 1 : ID numérique
    if (typeof userOrId === 'number' || /^\d+$/.test(String(userOrId))) {
      const numId = Number(userOrId);
      for (const m of masters) {
        if (m.id && m.id === numId) return true;
        if (m.username) {
          const details = this.getUserDetails(numId);
          if (details && details.username && details.username.toLowerCase().replace(/^@/, '') === m.username.toLowerCase()) {
            if (!m.id) {
              m.id = numId;
              this.save();
            }
            return true;
          }
        }
      }
      return false;
    }

    // Cas 2 : Objet utilisateur ({ id, username, first_name })
    const user = userOrId;
    const userId = user.id ? Number(user.id) : null;
    const userUsername = user.username ? user.username.toLowerCase().replace(/^@/, '').trim() : null;

    for (const m of masters) {
      if (userId && m.id && m.id === userId) return true;
      if (userUsername && m.username && m.username.toLowerCase().replace(/^@/, '') === userUsername) {
        if (!m.id && userId) {
          m.id = userId;
          this.save();
        }
        return true;
      }
    }

    return false;
  }

  addAdminId(adminId) {
    if (!adminId) return;
    if (!this.data.adminIds) this.data.adminIds = [];
    if (!this.data.adminIds.includes(adminId)) {
      this.data.adminIds.push(adminId);
      this.save();
    }
  }

  isOwnerOrAdmin(userId) {
    if (!userId) return false;
    if (this.isMaster(userId)) return true;
    if (this.data.ownerId === userId) return true;
    if (this.data.adminIds && this.data.adminIds.includes(userId)) return true;
    return false;
  }

  getActiveBansList() {
    return Object.values(this.data.bannedUsers || {});
  }

  getActiveMutesList() {
    const now = Date.now();
    return Object.values(this.data.mutedUsers || {}).filter(m => m.unmuteTimestamp > now);
  }

  // --- Gestion du Catalogue des Séries / Télé-Réalités ---
  addShow(name, link, description = '', customAliases = []) {
    if (!name || !link) return null;

    const cleanName = name.trim();
    // Gérer les ligatures françaises (œ, æ)
    const normalizedName = cleanName
      .toLowerCase()
      .replace(/œ/g, 'oe')
      .replace(/æ/g, 'ae');

    // Générer un slug ID : ex "La Villa des Cœurs Brisés" -> "la-villa-des-coeurs-brises"
    const id = normalizedName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // Générer des alias automatiques
    const autoAliases = new Set();
    autoAliases.add(cleanName.toLowerCase());
    autoAliases.add(normalizedName);
    
    // Version sans accents
    const noAccents = normalizedName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    autoAliases.add(noAccents);

    // Version sans articles (le, la, les)
    const withoutArticles = noAccents.replace(/^(le|la|les|l'|l )\s+/i, '').trim();
    if (withoutArticles && withoutArticles !== noAccents) {
      autoAliases.add(withoutArticles);
    }

    // Alias personnalisés
    if (Array.isArray(customAliases)) {
      customAliases.forEach(a => a && autoAliases.add(a.toLowerCase().trim()));
    }

    const show = {
      id,
      name: cleanName,
      link: link.trim(),
      description: description.trim(),
      aliases: Array.from(autoAliases),
      addedAt: new Date().toISOString()
    };

    if (!this.data.shows) this.data.shows = {};
    this.data.shows[id] = show;
    this.save();
    this.saveShowsCatalog();
    if (!isTestEnv) {
      this.createBackup(`Ajout de l'émission "${cleanName}"`);
    }
    return show;
  }

  removeShow(nameOrId) {
    if (!nameOrId || !this.data.shows) return false;
    const target = this.findShow(nameOrId);
    if (target && this.data.shows[target.id]) {
      const showName = target.name;
      delete this.data.shows[target.id];
      this.save();
      this.saveShowsCatalog();
      if (!isTestEnv) {
        this.createBackup(`Suppression de l'émission "${showName}"`);
      }
      return true;
    }
    return false;
  }

  getShows() {
    return this.data.shows || {};
  }

  getShowsList() {
    return Object.values(this.data.shows || {}).sort((a, b) => a.name.localeCompare(b.name));
  }

  exportShowsJson() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      totalShows: Object.keys(this.data.shows || {}).length,
      shows: this.data.shows || {}
    }, null, 2);
  }

  importShows(showsInput) {
    if (!showsInput || typeof showsInput !== 'object') return 0;
    let list = [];
    if (Array.isArray(showsInput)) {
      list = showsInput;
    } else if (showsInput.shows && typeof showsInput.shows === 'object') {
      list = Object.values(showsInput.shows);
    } else {
      list = Object.values(showsInput);
    }

    let importedCount = 0;
    for (const item of list) {
      if (item && item.name && item.link) {
        this.addShow(item.name, item.link, item.description || '', item.aliases || []);
        importedCount++;
      }
    }
    return importedCount;
  }

  /**
   * Exporte l'état complet du bot pour la persistance Cloud (utilisateurs, séries, configurations)
   */
  getFullState() {
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      moderation_db: JSON.parse(JSON.stringify(this.data)),
      shows_catalog: JSON.parse(JSON.stringify(this.getShows()))
    };
  }

  /**
   * Restaure l'état complet du bot depuis une sauvegarde Cloud (Cloud Sync)
   */
  restoreFullState(state) {
    if (!state || typeof state !== 'object') return false;
    let modified = false;

    if (state.moderation_db && typeof state.moderation_db === 'object') {
      const dbData = state.moderation_db;
      this.data = {
        ...this.data,
        ...dbData,
        shows: { ...(this.data.shows || {}), ...(dbData.shows || {}) },
        knownUsers: { ...(this.data.knownUsers || {}), ...(dbData.knownUsers || {}) },
        privateUsers: { ...(this.data.privateUsers || {}), ...(dbData.privateUsers || {}) },
        usernameToId: { ...(this.data.usernameToId || {}), ...(dbData.usernameToId || {}) },
        masters: Array.isArray(dbData.masters) && dbData.masters.length > 0 ? dbData.masters : this.data.masters,
        managedChats: Array.isArray(dbData.managedChats) && dbData.managedChats.length > 0 ? dbData.managedChats : this.data.managedChats,
        auditChannelId: dbData.auditChannelId || this.data.auditChannelId,
        storageChatId: dbData.storageChatId || this.data.storageChatId,
        ownerId: dbData.ownerId || this.data.ownerId,
        mainGroupId: dbData.mainGroupId || this.data.mainGroupId
      };
      modified = true;
    }

    if (state.shows_catalog) {
      this.importShows(state.shows_catalog);
      modified = true;
    }

    if (modified) {
      this.save();
      this.saveShowsCatalog();
    }
    return modified;
  }

  findShow(query) {
    if (!query || !this.data.shows) return null;

    const raw = query.toLowerCase().trim().replace(/œ/g, 'oe').replace(/æ/g, 'ae');
    const cleanQuery = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanQuery) return null;

    const shows = Object.values(this.data.shows);

    // 1. Correspondance exacte par ID ou nom
    for (const s of shows) {
      if (s.id === cleanQuery || s.id === cleanQuery.replace(/\s+/g, '-')) return s;
      if (s.name.toLowerCase() === raw) return s;
    }

    // 2. Correspondance exacte dans les alias
    for (const s of shows) {
      if (s.aliases && s.aliases.some(a => a === cleanQuery || a === raw)) return s;
    }

    // 3. Inclusion du nom dans la requête ou de la requête dans le nom
    for (const s of shows) {
      const cleanShowName = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (cleanQuery.includes(cleanShowName) || cleanShowName.includes(cleanQuery)) {
        return s;
      }
      if (s.aliases) {
        for (const alias of s.aliases) {
          if (cleanQuery.includes(alias) || alias.includes(cleanQuery)) {
            // Éviter faux positif avec mots trop courts (ex: "la")
            if (alias.length >= 3 && cleanQuery.length >= 3) {
              return s;
            }
          }
        }
      }
    }

    // 4. Mots significatifs en commun (ex: "villa", "secret", "cinquante", "frenchie")
    const stopWords = new Set(['le', 'la', 'les', 'des', 'du', 'de', 'un', 'une', 'dans', 'sur', 'pour', 'qui', 'quoi', 'donne', 'lien', 'moi', 'stp', 'svp', 'salut', 'bonjour', 'bonsoir', 'cherche', 'veux', 'voir']);
    const queryTokens = cleanQuery.split(' ').filter(t => t.length >= 3 && !stopWords.has(t));

    if (queryTokens.length > 0) {
      for (const s of shows) {
        const cleanShowName = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const showTokens = cleanShowName.split(' ').filter(t => t.length >= 3 && !stopWords.has(t));
        
        const hasCommonToken = queryTokens.some(qt => showTokens.some(st => st.includes(qt) || qt.includes(st)));
        if (hasCommonToken) {
          return s;
        }
      }
    }

    return null;
  }
}

export const db = new ModerationDatabase();
