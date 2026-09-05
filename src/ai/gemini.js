import { GoogleGenAI } from '@google/genai';
import { config, getBotContext } from '../config.js';
import {
  IMAGE_MODERATION_SYSTEM_INSTRUCTION,
  TEXT_MODERATION_SYSTEM_INSTRUCTION,
  INTERVENTION_EVALUATION_SYSTEM_INSTRUCTION,
  buildConversationPrompt,
  buildInterventionPrompt,
  sanitizeMimicryIfNeeded
} from './prompts.js';

class AIService {
  constructor() {
    this.geminiClient = null;
    this.provider = 'none';
    this.isConfigured = false;
    this.init();
  }

  init() {
    const requestedProvider = config.aiProvider;

    // 1. Si GROQ est demandé ou actif par défaut
    if (requestedProvider === 'groq' && config.groqApiKey && config.groqApiKey !== 'VOTRE_CLE_GROQ_ICI') {
      this.provider = 'groq';
      this.isConfigured = true;
      console.log('====================================================');
      console.log('⚡ Moteur IA actif : GROQ CLOUD (100% Gratuit)');
      console.log(`🤖 Modèle Texte & Conversation : ${config.groqTextModel}`);
      console.log(`👁️  Modèle Vision & Images : ${config.groqVisionModel}`);
      console.log('====================================================');
      return;
    }

    // 2. Si GEMINI est demandé
    if (requestedProvider === 'gemini' && config.geminiApiKey && config.geminiApiKey !== 'VOTRE_CLE_GEMINI_ICI') {
      try {
        this.geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
        this.provider = 'gemini';
        this.isConfigured = true;
        console.log('====================================================');
        console.log('⚡ Moteur IA actif : GOOGLE GEMINI');
        console.log(`🤖 Modèle : ${config.geminiModel}`);
        console.log('====================================================');
        return;
      } catch (err) {
        console.error('[GEMINI] Erreur d\'initialisation Gemini:', err.message);
      }
    }

    // 3. Repli automatique si l'autre clé est fournie
    if (config.groqApiKey && config.groqApiKey !== 'VOTRE_CLE_GROQ_ICI') {
      this.provider = 'groq';
      this.isConfigured = true;
      console.log('[GROQ] Moteur Groq sélectionné automatiquement.');
      return;
    }

    if (config.geminiApiKey && config.geminiApiKey !== 'VOTRE_CLE_GEMINI_ICI') {
      try {
        this.geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
        this.provider = 'gemini';
        this.isConfigured = true;
        console.log('[GEMINI] Moteur Gemini sélectionné automatiquement.');
        return;
      } catch (err) {
        console.error('[GEMINI] Erreur:', err.message);
      }
    }

    console.warn('[AI] ⚠️ Aucune clé API active. Le bot fonctionne en mode sécurité locale.');
  }

  getActiveModelName() {
    if (this.provider === 'groq') {
      return `Groq (${config.groqTextModel})`;
    }
    if (this.provider === 'gemini') {
      return `Gemini (${config.geminiModel})`;
    }
    return 'Filtre local rapide';
  }

  /**
   * Analyse une image pour détecter du contenu adulte, NSFW, violent
   */
  async analyzeImage(base64Data, mimeType = 'image/jpeg') {
    if (!this.isConfigured || config.mockMode) {
      return {
        isInappropriate: false,
        isAdultNsfw: false,
        severity: 'none',
        action: 'none',
        reason: 'Mode local'
      };
    }

    if (this.provider === 'groq') {
      try {
        return await this.callGroqVision(base64Data, mimeType);
      } catch (err) {
        console.error('[GROQ] Erreur analyse image:', err.message);
      }
    } else if (this.provider === 'gemini') {
      try {
        const response = await this.geminiClient.models.generateContent({
          model: config.geminiModel,
          contents: [
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            },
            { text: "Analyse cette image selon les consignes strictes de sécurité. Réponds uniquement en JSON." }
          ],
          config: {
            systemInstruction: IMAGE_MODERATION_SYSTEM_INSTRUCTION,
            responseMimeType: "application/json"
          }
        });

        const responseText = response.text ? response.text.trim() : '{}';
        const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(cleanJson);

        return {
          isInappropriate: Boolean(parsed.isInappropriate || parsed.isAdultNsfw),
          isAdultNsfw: Boolean(parsed.isAdultNsfw),
          severity: parsed.severity || 'none',
          action: parsed.action || (parsed.isAdultNsfw ? 'ban' : 'none'),
          reason: parsed.reason || 'Image analysée par l\'IA'
        };
      } catch (err) {
        console.error('[GEMINI] Erreur analyse image:', err.message);
      }
    }

    return {
      isInappropriate: false,
      isAdultNsfw: false,
      severity: 'none',
      action: 'none',
      reason: 'Image analysée'
    };
  }

  /**
   * Analyse sémantique d'un texte pour détecter des insultes ou du harcèlement
   */
  async analyzeText(text) {
    if (!this.isConfigured || config.mockMode) {
      return {
        isViolation: false,
        severity: 'none',
        action: 'none',
        reason: 'Mode local'
      };
    }

    if (this.provider === 'groq') {
      try {
        return await this.callGroqText(text);
      } catch (err) {
        console.error('[GROQ] Erreur analyse texte:', err.message);
      }
    } else if (this.provider === 'gemini') {
      try {
        const response = await this.geminiClient.models.generateContent({
          model: config.geminiModel,
          contents: [
            { text: `Analyse ce message de groupe Telegram : "${text}"` }
          ],
          config: {
            systemInstruction: TEXT_MODERATION_SYSTEM_INSTRUCTION,
            responseMimeType: "application/json"
          }
        });

        const responseText = response.text ? response.text.trim() : '{}';
        const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(cleanJson);

        return {
          isViolation: Boolean(parsed.isViolation),
          severity: parsed.severity || 'none',
          action: parsed.action || 'none',
          reason: parsed.reason || 'Analyse sémantique du texte'
        };
      } catch (err) {
        console.error('[GEMINI] Erreur analyse texte:', err.message);
      }
    }

    return {
      isViolation: false,
      severity: 'none',
      action: 'none',
      reason: 'Vérification locale'
    };
  }

  /**
   * Génère une réponse locale de secours variée et contextuelle (hors-ligne ou indisponibilité API)
   */
  generateLocalFallbackReply(userMessage, userName, isMaster = false, recentMessages = []) {
    const rawLower = (userMessage || '').toLowerCase().trim();
    const normalized = rawLower
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // 1. CAS DU MAÎTRE SUPRÊME
    if (isMaster) {
      if (/\b(se passe quoi|qui se passe|quoi le (probleme|souci)|qui a fait quoi|explique|raconte|qu'?est[ -]?ce qu'?il y a|pourquoi tu m'?as (appele|ping|notifie))\b/i.test(normalized) && recentMessages && recentMessages.length > 0) {
        const events = recentMessages
          .slice(-5)
          .filter(m => !m.isBot)
          .map(m => `${m.userName} ("${m.text}")`)
          .join(', ');
        return `À vos ordres, Maître ! ✨ Voici ce qui vient de se passer dans les échanges récents : ${events}. Que commande Sa Majesté ? 👑`;
      }

      if (/\b(ca va|comment vas|la forme|tu vas bien|bien ou quoi|salut|coucou|bonjour|hello|hey)\b/i.test(normalized)) {
        const masterGreetings = [
          `À vos ordres, Maître ! ✨ Tout se passe à merveille. Je veille scrupuleusement sur votre groupe Télé-Réalité. Que désire Sa Majesté ? 👑`,
          `À vos ordres, Maître ! ✨ En pleine forme et toujours à votre service royal. Avez-vous des ordres pour moi ? 👑`,
          `Toujours prête à vous servir, mon Maître vénéré ! ✨ L'ambiance est sous contrôle. Que commande Sa Majesté aujourd'hui ? 👑`
        ];
        return masterGreetings[Math.floor(Math.random() * masterGreetings.length)];
      }

      return `À vos ordres, Maître ! ✨ Je suis à votre entière disposition sur le canal Télé-Réalité. Que commande Sa Majesté ? 👑`;
    }

    // 2. CAS D'UN MEMBRE ORDINAIRE DU GROUPE
    // Salutations / "Ça va"
    if (/\b(ca va|comment vas|tu vas bien|la forme|bien ou quoi|ca roule)\b/i.test(normalized)) {
      const greetingsReplies = [
        `Coucou ${userName} ! Ça va super bien, merci ! En pleine forme pour débriefer les derniers épisodes avec vous ! Et toi, tout roule ? 📺🍿`,
        `Hello ${userName} ! Tout va au top ! Prête pour le prochain prime et les scoops du jour. Tu as passé une bonne journée ? ✨`,
        `Coucou ! Très bien merci, toujours fidèle au poste pour commenter nos émissions favorites ! Et de ton côté, comment ça va ? 💖`
      ];
      return greetingsReplies[Math.floor(Math.random() * greetingsReplies.length)];
    }

    // "Bonjour" / "Salut" / "Coucou"
    if (/\b(bonjour|salut|coucou|hello|hey|bonsoir)\b/i.test(lower)) {
      const welcomeReplies = [
        `Coucou ${userName} ! Ravie de te retrouver ici ! Tu as suivi les derniers rebondissements à la télé ? ✨`,
        `Hello ${userName} ! Bienvenue dans le salon ! Tu es chaud(e) pour débriefer les aventures de nos candidats ? 🍿`,
        `Coucou ! J'espère que tu passes une super journée ! Quoi de neuf de ton côté ? 📺`
      ];
      return welcomeReplies[Math.floor(Math.random() * welcomeReplies.length)];
    }

    // Discussion télé-réalité
    if (/\b(secret story|les cinquante|koh[- ]lanta|villa|anges|marseillais|candidat|clash|élimin|épisode|prime)\b/i.test(lower)) {
      const tvReplies = [
        `Les stratégies et les clashs sont tellement intenses cette saison, impossible de décrocher ! Tu as un favori toi ? 🍿`,
        `Franchement les épisodes sont dingues ces jours-ci, les trahisons s'enchaînent ! Et toi, tu en penses quoi ? ✨`
      ];
      return tvReplies[Math.floor(Math.random() * tvReplies.length)];
    }

    // Réponse générale variée (fini la phrase unique répétée !)
    const defaultReplies = [
      `Coucou ${userName} ! Je suis là si tu veux papoter télé-réalité ou si tu as une question sur nos émissions ! 📺✨`,
      `Présente ! Toujours au taquet pour commenter les rebondissements télé avec vous dans la bonne humeur ! 🍿`,
      `Coucou ! Tout roule sur le groupe, que de la bonne humeur et du divertissement ! Qu'est-ce qui t'amène de beau ? ✨`
    ];
    return defaultReplies[Math.floor(Math.random() * defaultReplies.length)];
  }

  /**
   * Génère une réponse intelligente contextuelle de la modératrice
   */
  async generateReply(userMessage, userName, isMaster = false, allowMimicry = false, recentMessages = []) {
    if (!this.isConfigured || config.mockMode) {
      return this.generateLocalFallbackReply(userMessage, userName, isMaster, recentMessages);
    }

    const context = getBotContext();
    const prompt = buildConversationPrompt(userMessage, userName, context, isMaster, allowMimicry, recentMessages);

    let raw = null;
    if (this.provider === 'groq') {
      try {
        raw = await this.callGroqReply(prompt);
      } catch (err) {
        console.error('[GROQ] Erreur réponse conversationnelle:', err.message);
      }
    } else if (this.provider === 'gemini') {
      try {
        const response = await this.geminiClient.models.generateContent({
          model: config.geminiModel,
          contents: [{ text: prompt }]
        });
        if (response.text) raw = response.text.trim();
      } catch (err) {
        console.error('[GEMINI] Erreur réponse conversationnelle:', err.message);
      }
    }

    if (raw) {
      let sanitized = sanitizeMimicryIfNeeded(raw, allowMimicry);
      if (isMaster && !sanitized.toLowerCase().includes('maître') && !sanitized.toLowerCase().includes('majesté') && !sanitized.toLowerCase().includes('seigneur')) {
        sanitized = `À vos ordres, Maître ! ✨ ${sanitized}`;
      }
      return sanitized;
    }

    return this.generateLocalFallbackReply(userMessage, userName, isMaster, recentMessages);
  }

  /**
   * Évalue si une intervention spontanée est nécessaire (tension, question, apaisement)
   */
  async evaluateIntervention(recentMessages, currentMessage, userName) {
    if (!this.isConfigured || config.mockMode) {
      return { shouldReply: false };
    }

    const context = getBotContext();
    const prompt = buildInterventionPrompt(recentMessages, currentMessage, userName, context);

    if (this.provider === 'groq') {
      const candidateModels = [
        config.groqTextModel || 'qwen/qwen3.8-27b',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b'
      ].filter((m, i, arr) => m && arr.indexOf(m) === i);

      for (const model of candidateModels) {
        try {
          const payload = {
            model,
            max_tokens: 300,
            messages: [
              { role: 'system', content: INTERVENTION_EVALUATION_SYSTEM_INSTRUCTION },
              { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
          };
          if (model.startsWith('openai/')) {
            payload.reasoning_format = 'hidden';
          }

          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.groqApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (!res.ok) continue;

          const data = await res.json();
          let content = data.choices?.[0]?.message?.content || '{}';
          content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          const cleanJson = jsonMatch ? jsonMatch[0] : content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
          const parsed = JSON.parse(cleanJson);

          return {
            shouldReply: Boolean(parsed.shouldReply),
            reason: parsed.reason || 'none',
            suggestedReply: parsed.suggestedReply ? parsed.suggestedReply.trim() : null
          };
        } catch (err) {
          console.error(`[GROQ] Erreur évaluation intervention avec ${model}:`, err.message);
        }
      }
    } else if (this.provider === 'gemini') {
      try {
        const response = await this.geminiClient.models.generateContent({
          model: config.geminiModel,
          contents: [{ text: prompt }],
          config: {
            systemInstruction: INTERVENTION_EVALUATION_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json'
          }
        });

        const responseText = response.text ? response.text.trim() : '{}';
        const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(cleanJson);

        return {
          shouldReply: Boolean(parsed.shouldReply),
          reason: parsed.reason || 'none',
          suggestedReply: parsed.suggestedReply ? parsed.suggestedReply.trim() : null
        };
      } catch (err) {
        console.error('[GEMINI] Erreur évaluation intervention:', err.message);
      }
    }

    return { shouldReply: false };
  }

  // --- Appels API Groq (100% Gratuits) ---

  async callGroqVision(base64Data, mimeType) {
    const candidateModels = [
      config.groqVisionModel || 'qwen/qwen3.8-27b',
      'qwen/qwen3.8-27b',
      'qwen/qwen3.6-27b'
    ].filter((m, i, arr) => m && arr.indexOf(m) === i);

    for (const model of candidateModels) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.groqApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            max_tokens: 1200,
            messages: [
              { role: 'system', content: IMAGE_MODERATION_SYSTEM_INSTRUCTION },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Analyse cette image selon les consignes. Réponds STRICTEMENT et DIRECTEMENT au format JSON sans texte additionnel.' },
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
                ]
              }
            ]
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.warn(`[GROQ VISION] ⚠️ Modèle ${model} a retourné une erreur HTTP ${res.status}:`, errData.error?.message || res.statusText);
          continue;
        }

        const data = await res.json();
        let content = data.choices?.[0]?.message?.content || '{}';
        content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.warn(`[GROQ VISION] Pas de JSON détecté dans la réponse de ${model}`);
          continue;
        }
        const parsed = JSON.parse(jsonMatch[0]);

        return {
          isInappropriate: Boolean(parsed.isInappropriate || parsed.isAdultNsfw),
          isAdultNsfw: Boolean(parsed.isAdultNsfw),
          severity: parsed.severity || 'none',
          action: parsed.action || (parsed.isAdultNsfw ? 'ban' : 'none'),
          reason: parsed.reason || 'Image analysée par l\'IA',
          modelUsed: model
        };
      } catch (err) {
        console.warn(`[GROQ VISION] ⚠️ Exception avec modèle ${model}:`, err.message);
      }
    }

    return {
      isInappropriate: false,
      isAdultNsfw: false,
      severity: 'none',
      action: 'none',
      reason: 'Échec de l\'analyse Vision après tentative sur tous les modèles Groq',
      modelUsed: 'aucun'
    };
  }

  async callGroqText(text) {
    const candidateModels = [
      config.groqTextModel || 'qwen/qwen3.8-27b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b'
    ].filter((m, i, arr) => m && arr.indexOf(m) === i);

    for (const model of candidateModels) {
      try {
        const payload = {
          model,
          max_tokens: 350,
          messages: [
            { role: 'system', content: TEXT_MODERATION_SYSTEM_INSTRUCTION },
            { role: 'user', content: text }
          ],
          response_format: { type: 'json_object' }
        };
        if (model.startsWith('openai/')) {
          payload.reasoning_format = 'hidden';
        }

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.groqApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.warn(`[GROQ] Modèle modération texte ${model} retour ${res.status}:`, errData.error?.message || res.statusText);
          continue;
        }

        const data = await res.json();
        let content = data.choices?.[0]?.message?.content || '{}';
        content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const cleanJson = jsonMatch ? jsonMatch[0] : content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(cleanJson);

        return {
          isViolation: Boolean(parsed.isViolation),
          severity: parsed.severity || 'none',
          action: parsed.action || 'none',
          reason: parsed.reason || 'Analyse sémantique'
        };
      } catch (err) {
        console.error(`[GROQ] Erreur analyse texte avec ${model}:`, err.message);
      }
    }

    return {
      isViolation: false,
      severity: 'none',
      action: 'none',
      reason: 'Vérification locale'
    };
  }

  async callGroqReply(prompt) {
    const candidateModels = [
      config.groqTextModel || 'qwen/qwen3.8-27b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'groq/compound-mini'
    ].filter((m, i, arr) => m && arr.indexOf(m) === i);

    for (const model of candidateModels) {
      try {
        const payload = {
          model,
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        };
        if (model.startsWith('openai/')) {
          payload.reasoning_format = 'hidden';
        }

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.groqApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.warn(`[GROQ] Modèle conversationnel ${model} retour ${res.status}:`, errData.error?.message || res.statusText);
          continue;
        }

        const data = await res.json();
        let content = data.choices?.[0]?.message?.content?.trim() || null;
        if (content) {
          content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
          if (content) return content;
        }
      } catch (err) {
        console.error(`[GROQ] Exception avec modèle ${model}:`, err.message);
      }
    }
    return null;
  }

  /**
   * Génère une réponse texte libre pour les demandes d'assistance privée, annonces, ou quiz
   */
  async generateTextResponse(prompt, maxTokens = 500) {
    if (!this.isConfigured || config.mockMode) {
      return "Je suis à votre disposition pour vous aider dans la gestion et l'animation du groupe !";
    }

    if (this.provider === 'groq') {
      const candidateModels = [
        config.groqTextModel || 'qwen/qwen3.8-27b',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'groq/compound-mini'
      ].filter((m, i, arr) => m && arr.indexOf(m) === i);

      for (const model of candidateModels) {
        try {
          const payload = {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }]
          };
          if (model.startsWith('openai/')) {
            payload.reasoning_format = 'hidden';
          }

          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.groqApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (!res.ok) continue;

          const data = await res.json();
          let content = data.choices?.[0]?.message?.content?.trim() || null;
          if (content) {
            content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
            if (content) return content;
          }
        } catch (err) {
          console.error(`[GROQ] Erreur generateTextResponse avec ${model}:`, err.message);
        }
      }
    } else if (this.provider === 'gemini') {
      try {
        const response = await this.geminiClient.models.generateContent({
          model: config.geminiModel,
          contents: [{ text: prompt }]
        });
        if (response.text) return response.text.trim();
      } catch (err) {
        console.error('[GEMINI] Erreur generateTextResponse:', err.message);
      }
    }

    return "Désolée, impossible de formuler une réponse pour le moment.";
  }

  /**
   * Génère une réponse dans un dialogue multi-tours avec mémoire et consignes système
   * @param {string} systemInstruction Consigne de rôle et contexte
   * @param {Array<{role: 'user'|'assistant', content: string}>} history Historique récent des messages
   * @param {number} maxTokens
   * @param {boolean} allowMimicry
   */
  async generateChatResponse(systemInstruction, history = [], maxTokens = 350, allowMimicry = false) {
    if (!this.isConfigured || config.mockMode) {
      return null;
    }

    if (this.provider === 'groq') {
      const candidateModels = [
        config.groqTextModel || 'qwen/qwen3.8-27b',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'groq/compound-mini'
      ].filter((m, i, arr) => m && arr.indexOf(m) === i);

      const messages = [];
      if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
      }
      for (const msg of history) {
        if (msg && msg.role && msg.content) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      for (const model of candidateModels) {
        try {
          const payload = {
            model,
            max_tokens: maxTokens,
            messages
          };
          if (model.startsWith('openai/')) {
            payload.reasoning_format = 'hidden';
          }

          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.groqApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (!res.ok) continue;

          const data = await res.json();
          let content = data.choices?.[0]?.message?.content?.trim() || null;
          if (content) {
            content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
            content = sanitizeMimicryIfNeeded(content, allowMimicry);
            if (content) return content;
          }
        } catch (err) {
          console.error(`[GROQ] Erreur generateChatResponse avec ${model}:`, err.message);
        }
      }
    } else if (this.provider === 'gemini') {
      try {
        let fullPrompt = systemInstruction ? `${systemInstruction}\n\n` : '';
        for (const msg of history) {
          fullPrompt += `${msg.role === 'user' ? 'Membre' : 'Léna'} : ${msg.content}\n`;
        }
        const response = await this.geminiClient.models.generateContent({
          model: config.geminiModel,
          contents: [{ text: fullPrompt }]
        });
        if (response.text) return sanitizeMimicryIfNeeded(response.text.trim(), allowMimicry);
      } catch (err) {
        console.error('[GEMINI] Erreur generateChatResponse:', err.message);
      }
    }

    return null;
  }
}

export const geminiService = new AIService();
