---
title: Lena Moderator Bot
emoji: 📺
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# 📺 Bot Telegram Léna Situations Modératrice Télé-Réalité ✨👑 (100% Gratuit)

Bot Telegram autonome, ultra-performant et intelligent, spécialement conçu pour animer et modérer une communauté de fans de Télé-Réalité (*Secret Story, Koh-Lanta, Les Cinquante, La Villa des Cœurs Brisés, Frenchie Shore, etc.*).

Il combine une modération stricte (anti-NSFW par IA vision, anti-spam, anti-flood, anti-liens, sanctions graduées), une personnalité solaire et bienveillante inspirée de Léna Situations (avec régulateur de fréquence de mimiques), un statut de **Maître Suprême** exécutant vos ordres en langage naturel, une **mémoire continue des 20 derniers messages du groupe**, et un **service confidentiel de streaming** avec règle d'or anti-fuite.

**Coût d'utilisation : 0,00 € (Strictement aucun frais, API Groq Cloud et Gemini 100% gratuites).**

---

## ⚡ Fonctionnalités Clés de Production

1. **Vision IA par Groq Cloud ou Google Gemini (100% Gratuit)** :
   - Analyse instantanée de chaque photo ou image envoyée.
   - Détection automatique du contenu pour adulte (NSFW, pornographie, nudité explicite, gore).
   - **Action immédiate** : Suppression de l'image + **Bannissement définitif** du fauteur de troubles.
   - Respecte les photos normales de télé-réalité (candidats en maillot sur une plage ou épreuves sportives autorisés).

2. **👑 Statut de Maître Suprême & Ordres en Langage Naturel** :
   - Reconnaissance automatique de votre compte (`@VotrePseudo` ou `me`).
   - Ordres directs sans commande slash : *« Tu peux bannir celui-là »*, *« Mute-le 30 minutes »*, *« Débannis-le »*.
   - Rejet immédiat des ordres lancés par des membres non autorisés avec alerte au Maître.

3. **🧠 Mémoire Continue des 20 Derniers Messages** :
   - Le bot garde en mémoire les 20 à 30 derniers échanges du groupe.
   - Lorsque le Maître arrive et demande *« Il se passe quoi ? »*, le bot explique fidèlement et concrètement les faits réels (qui a demandé un lien, qui a voulu bannir qui) au lieu de phrases génériques.

4. **🌸 Vibe Léna Situations & Régulation de Fréquence** :
   - Sobriété à 90% pour des dialogues simples, naturels et bienveillants.
   - Expressions cultes (*« + = + »*, *« gros bisous »*, *« trop zinzin »*) limitées à 1 fois tous les 10 à 15 messages.

5. **🔒 Règle d'Or Anti-Leak & Distribution Confidentielle de Liens** :
   - ZÉRO lien diffusé dans le groupe public.
   - Redirection élégante et livraison confidentielle en message privé (MP).

6. **💾 Système de Sauvegarde à Double Redondance** :
   - Sauvegardes instantanées, fichier miroir `data/shows_catalog.json` et restauration automatique.

---

## 📋 Prérequis (100% Gratuits)

Vous avez uniquement besoin de deux choses :
1. **Un Token de Bot Telegram** (délivré gratuitement par Telegram via `@BotFather`).
2. **Une Clé API Google Gemini** (délivrée gratuitement par Google AI Studio, sans carte bancaire).

---

## 🛠️ Guide d'Installation Pas à Pas

### Étape 1 : Créer votre Bot Telegram (1 minute)

1. Ouvrez votre application Telegram et recherchez le compte officiel : **`@BotFather`**.
2. Envoyez la commande `/newbot`.
3. Donnez un nom d'affichage à votre bot (ex: `Sarah Modératrice Télé-Réalité`).
4. Choisissez un nom d'utilisateur (username) finissant obligatoirement par `bot` (ex: `TeleRealiteModoBot`).
5. `@BotFather` vous félicite et vous donne un **Token HTTP API** qui ressemble à ceci :
   `7123456789:AAHqXXXXXXXXXXXXX_XXXXXXXXXXXX`
   *(Copiez ce token, vous en aurez besoin à l'étape 3).*
6. **Réglage essentiel de confidentialité :**
   - Toujours dans `@BotFather`, envoyez la commande : `/setprivacy`
   - Sélectionnez votre bot.
   - Cliquez sur **`Disable`** *(Désactiver)*.
   - *Pourquoi ? Cela permet à votre bot d'avoir accès aux messages et images du groupe pour les analyser et les modérer.*

---

### Étape 2 : Récupérer votre Clé API Google Gemini Gratuite (1 minute)

1. Rendez-vous sur le site officiel de Google AI Studio : **[https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)**.
2. Connectez-vous avec n'importe quel compte Google / Gmail.
3. Cliquez sur le bouton bleu **`Create API Key`** (Créer une clé API).
4. Copiez la clé générée (commence par `AIzaSy...`).
   *(Cette clé est 100% gratuite, sans aucune carte de crédit demandée, avec un quota généreux largement suffisant pour un grand groupe Telegram).*

---

### Étape 3 : Configurer le Bot

Ouvrez le fichier `.env` situé dans le dossier du bot et collez vos deux clés :

```env
TELEGRAM_BOT_TOKEN=7123456789:AAHqXXXXXXXXXXXXX_XXXXXXXXXXXX
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

*(Optionnel)* : Pour vous protéger contre toute sanction par erreur, ajoutez votre propre ID Telegram dans `ADMIN_USER_IDS`. Pour connaître votre ID Telegram, envoyez un message au bot Telegram gratuit `@userinfobot`.

---

### Étape 4 : Ajouter le Bot dans votre Groupe et lui donner les Droits Admin

1. Ouvrez votre groupe Telegram de télé-réalité.
2. Cliquez sur **Ajouter des membres** et cherchez le nom d'utilisateur de votre bot (ex: `@TeleRealiteModoBot`).
3. Allez dans les **Paramètres du groupe** $\rightarrow$ **Administrateurs** $\rightarrow$ **Ajouter un administrateur**.
4. Sélectionnez votre bot et cochez obligatoirement ces permissions :
   - ✅ **Supprimer les messages** (*Delete messages*)
   - ✅ **Bannir des utilisateurs** (*Ban users*)
   - ✅ **Restreindre les membres** (*Restrict members*)
5. Validez. Votre bot est désormais paré à protéger le groupe !

---

### Étape 5 : Lancer le Bot

#### Option A : En 1 clic sous Windows
Double-cliquez simplement sur le fichier :
👉 **`start.bat`**

#### Option B : En ligne de commande
Dans le dossier du projet, tapez :
```bash
npm start
```

Le terminal affichera :
```text
====================================================
🚀 Démarrage du Bot Telegram Télé-Réalité Modérateur
====================================================
[GEMINI] Service initialisé avec succès (Modèle: gemini-2.5-flash )
🤖 Bot connecté avec succès sous le nom : @TeleRealiteModoBot (Sarah)
✅ Le bot écoute activement les messages Telegram...
📡 Service de modération actif 24h/24 !
```

---

## 👑 Commandes Disponibles

### 👑 Salle de Contrôle Privée & Rôle de Maître :
- `/menu` ou `/panel` (en MP avec le bot) : Ouvre le tableau de bord interactif avec boutons tactiles (dont **👑 Gérer les Maîtres** pour voir, ajouter ou retirer des maîtres en direct).
- `/masters` : Affiche la liste des Maîtres Suprêmes enregistrés.
- `/addmaster @VotrePseudo` (ou `/addmaster me`) : Déclare un compte comme Maître Suprême.
- `/delmaster @VotrePseudo` (ou `/delmaster ID`) : Retire un compte des Maîtres Suprêmes.
- `/addshow Nom | Lien | [Description]` : Ajouter une nouvelle télé-réalité au catalogue.
- `/delshow Nom ou ID` : Retirer une série du catalogue.
- `/backup` : Créer un point de restauration instantané.
- `/broadcast Votre message` : Diffuser une annonce officielle dans **tous les canaux et groupes** où le bot est administrateur.
- `/channels` ou `/canaux` : Lister et gérer tous les canaux et groupes de diffusion avec boutons interactifs de suppression.
- `/addchannel @canal` : Associer manuellement un canal (ou transférez simplement un message du canal au bot en MP !).
- `/delchannel ID` : Retirer un canal ou groupe de la liste de diffusion.

### 👥 Pour tous les membres :
- `/start` : Présentation du bot (en groupe) ou accueil personnalisé et demande d'émissions (en MP).
- `/rules` : Règles officielles du groupe.
- `/liste` ou `/series` (en MP) : Consulter les émissions disponibles.
- Taguer `@NomDuBot` ou lui parler : Réponses courtes, punchy et bienveillantes avec la vibe Léna Situations.

### 🛡️ Pour les Administrateurs dans le groupe :
Vous pouvez sanctionner par **réponse directe au message**, par **@pseudo**, ou par **ID numérique** :
- `/warn [@pseudo]` : Avertissement gradué (1er = Rappel, 2ème = Mute 15 min, 3ème = Ban définitif).
- `/mute [@pseudo] [minutes]` : Mise en sourdine temporaire (15 min par défaut).
- `/unmute [@pseudo]` : Rétablir la parole.
- `/ban [@pseudo]` : Bannissement direct et définitif.
- `/unban [@pseudo ou ID]` : Débannir un membre.
- `/slowmode [secondes]` : Ralentir le chat en cas d'excitation (ex: `/slowmode 15` ou `0` pour désactiver).
- `/lockdown` & `/unlock` : Verrouillage et déverrouillage d'urgence du groupe.
- `/stats` : Bilan en direct de la modération (messages scannés, images IA, bans, mutes, floods).
- `/reload` : Synchroniser à chaud les consignes de `context.txt`.

---

## 🎨 Personnaliser le Contexte et ce que fait le Bot (`context.txt`)

Vous disposez d'un fichier dédié très simple : [**`context.txt`**](file:///C:/Users/PC%20SAMSUNG/.gemini/antigravity/scratch/telegram-reality-moderator/context.txt).

Ouvrez-le simplement avec le Bloc-Notes (Notepad) pour y décrire en français tout ce que vous voulez :
1. **Ce que vous faites concrètement** : la thématique de votre canal, vos liens, vos projets, vos actus.
2. **Ce que le bot doit répondre** : réponses aux questions fréquentes des membres (ex: heures des primes, règles, liens).
3. **Comment réagir aux tensions** : comment apaiser la discussion en cas d'embrouille naissante avec humour et esprit télé-réalité.

Le bot recharge automatiquement ce fichier sans même avoir besoin de redémarrer !

### 🤖 Fonctionnement des Interventions Spontanées Intelligentes
Le bot sait se taire quand les membres discutent calmement entre eux. Il n'intervient que dans 2 situations précises :
- **Si les tensions montent entre deux membres** : Il envoie un mot d'apaisement bienveillant et drôle pour détendre l'atmosphère avant l'insulte.
- **Si quelqu'un pose une question d'aide** : Il répond avec précision selon le contexte fourni.
- **Protection anti-spam** : Un délai d'attente intelligent empêche le bot d'inonder le chat.

---

## 🌐 Hébergement Gratuit 24h/24 (Sans laisser son PC allumé)

Si vous ne souhaitez pas laisser votre ordinateur personnel allumé, vous pouvez héberger ce bot gratuitement 24h/24 :

1. **Koyeb / Render / Fly.io / Railway** :
   - Déposez ce dossier sur votre compte GitHub.
   - Connectez votre dépôt sur [Render.com](https://render.com) ou [Koyeb.com](https://koyeb.com) en sélectionnant un "Background Worker" ou Web Service gratuit.
   - Définissez les variables d'environnement `TELEGRAM_BOT_TOKEN` et `GEMINI_API_KEY`.
2. **VPS Gratuit (Oracle Cloud Always Free)** :
   - Lancez simplement avec Docker : `docker compose up -d`.

---

## 🧪 Tests de Sécurité & Validation

Pour lancer la suite de tests automatisés (vérifiant les filtres de mots, la persistance des bans, et les règles d'immunité) :
```bash
npm test
```
Tous les tests sont pré-validés à 100%.
