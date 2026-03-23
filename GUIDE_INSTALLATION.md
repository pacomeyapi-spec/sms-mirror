# 📱 SMS Mirror — Guide d'installation complet

## Vue d'ensemble

SMS Mirror est composé de 3 parties :
1. **Le serveur** (hébergé sur Railway — gratuit)
2. **L'app Android** (APK à installer sur votre téléphone)
3. **Le tableau de bord** (accessible depuis n'importe quel navigateur)

---

## ⚡ ÉTAPE 1 — Déployer le serveur sur Railway (gratuit)

### 1.1 Créer un compte GitHub (si pas déjà fait)
→ Allez sur [github.com](https://github.com) et créez un compte gratuit

### 1.2 Créer un dépôt GitHub et pousser le code
```bash
# Sur votre ordinateur, dans le dossier sms-mirror/ :
cd sms-mirror
git init
git add .
git commit -m "SMS Mirror initial"
git branch -M main
git remote add origin https://github.com/VOTRE_USERNAME/sms-mirror.git
git push -u origin main
```

### 1.3 Obtenir l'APK via GitHub Actions
Après avoir poussé le code :
1. Allez sur GitHub → votre dépôt → onglet **Actions**
2. Cliquez sur **Build SMS Mirror APK** → **Run workflow**
3. Attendez ~5 minutes que la compilation se termine
4. Téléchargez le fichier **SmsMirror-debug.apk** dans les artefacts

### 1.4 Déployer le serveur sur Railway
1. Allez sur [railway.app](https://railway.app) et connectez-vous avec GitHub
2. Cliquez sur **New Project** → **Deploy from GitHub repo**
3. Sélectionnez votre dépôt `sms-mirror`
4. Railway détectera automatiquement que c'est un projet Node.js
5. Configurez le **Root Directory** sur `/server`
6. Ajoutez les **Variables d'environnement** :

| Variable | Valeur | Description |
|---|---|---|
| `PORT` | `3000` | Port du serveur |
| `DASHBOARD_PASSWORD` | `MotDePasseSecret123` | Votre mot de passe dashboard |
| `DEVICE_TOKEN` | `mon-token-android-secret` | Token de l'app Android |
| `SECRET_KEY` | `cle-jwt-tres-longue-et-aleatoire` | Clé de sécurité JWT |

7. Cliquez sur **Deploy**
8. Notez l'URL de votre serveur : `https://votre-app.railway.app`

---

## 📱 ÉTAPE 2 — Installer l'app Android

### 2.1 Activer les sources inconnues
1. Allez dans **Paramètres** → **Sécurité** (ou Confidentialité)
2. Activez **Sources inconnues** ou **Installer des apps inconnues**
3. Autorisez votre navigateur/gestionnaire de fichiers à installer des APK

### 2.2 Installer l'APK
1. Transférez le fichier `SmsMirror-debug.apk` sur votre Android
   (par câble USB, Bluetooth, email, ou Google Drive)
2. Ouvrez le fichier APK depuis le gestionnaire de fichiers
3. Appuyez sur **Installer**

### 2.3 Configurer l'app
Après l'installation, ouvrez SMS Mirror :

1. **URL du serveur** : entrez `https://votre-app.railway.app`
2. **Device Token** : entrez le même token que dans Railway (ex: `mon-token-android-secret`)
3. **Nom de l'appareil** : entrez un nom (ex: `Mon Samsung Galaxy`)
4. Appuyez sur **💾 Enregistrer**

### 2.4 Accorder les permissions
Appuyez sur **🔓 Accorder les permissions** :

1. ✅ **Lire les SMS** → Autoriser
2. ✅ **Journal des appels** → Autoriser
3. ✅ **Contacts** → Autoriser (pour résoudre les noms)
4. ✅ **Accès aux notifications** → Ouvrir les paramètres → activer **SMS Mirror**
5. ✅ **Ignorer les optimisations de batterie** → Autoriser (important !)

### 2.5 Démarrer la synchronisation
1. Appuyez sur **🔌 Tester la connexion** → vous devriez voir "Connexion réussie ✅"
2. Appuyez sur **▶ Démarrer**
3. L'app tourne maintenant en arrière-plan et synchronise automatiquement
