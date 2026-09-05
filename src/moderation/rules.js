/**
 * Règles locales de modération rapide (Regex & Mots-clés).
 * Permet une détection instantanée (0ms, 0 coût API) des cas évidents.
 */

// Normalisation de texte (suppression accents, mise en minuscule, suppression caractères répétitifs)
export function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Retire les accents
    .replace(/[@#$_.\-]/g, '')      // Retire les séparateurs anti-filtre (ex: f.d.p -> fdp)
    .replace(/(.)\1{2,}/g, '$1$1')  // Réduit les lettres répétées (ex: puuuutain -> puutain)
    .trim();
}

// Insultes graves entraînant un BANNISSEMENT DIRECT
const SEVERE_PATTERNS = [
  /\b(f+d+p+|fils\s*de\s*pute)\b/i,
  /\b(n+t+m+|nique\s*t(a|on)\s*(mere|darone|race))\b/i,
  /\b(encule(e)?|baise\s*ta\s*mere)\b/i,
  /\b(sale\s*(pute|arabe|noir|juif|chinetok|salope|flic))\b/i,
  /\b(suce(r)?\s*(ma|la)\s*bite)\b/i,
  /\b(creve|suicide[ -]?toi|va\s*te\s*faire\s*(foutre|pendre))\b/i,
  /\b(pedophile|pedo|violeur)\b/i
];

// Insultes légères ou vulgarités entraînant un MUTE TEMPORAIRE (15-60 min)
const SOFT_PATTERNS = [
  /\b(merde|fait\s*chier|putain|p*tain)\b/i,
  /\b(con(ne)?|connard|connasse)\b/i,
  /\b(ta\s*gueule|t+g+|ferme\s*(la|ta\s*gueule))\b/i,
  /\b(bouffon(ne)?|abrutis?|debil(e)?|cretin(e)?)\b/i,
  /\b(casse\s*toi|degage)\b/i,
  /\b(clown|tocard|idiot(e)?)\b/i
];

/**
 * Analyse rapide du texte avec le moteur de règles locales
 * @param {string} text - Message de l'utilisateur
 * @returns {null | { severity: 'severe' | 'soft', action: 'ban' | 'mute', reason: string }}
 */
export function evaluateLocalTextRules(text) {
  if (!text || typeof text !== 'string') return null;

  const raw = text.toLowerCase();
  const normalized = normalizeText(text);

  // 1. Vérification des insultes graves (BAN DIRECT)
  for (const pattern of SEVERE_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      return {
        severity: 'severe',
        action: 'ban',
        reason: "Insulte grave, propos haineux ou menace inacceptable."
      };
    }
  }

  // 2. Vérification des insultes modérées / vulgarité (MUTE)
  for (const pattern of SOFT_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      return {
        severity: 'soft',
        action: 'mute',
        reason: "Vulgarité ou manque de respect envers la communauté."
      };
    }
  }

  return null;
}
