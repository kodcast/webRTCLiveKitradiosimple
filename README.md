## Mise à jour du 11/09/2026

- Ajout d'un fichier JavaScript séparé afin de mieux organiser le code.
- Ajout d'un `manifest.json` pour permettre l'installation du lecteur sous forme de Web App.
- Ajout d'un fichier audio silencieux pour maintenir une lecture audio active et éviter que certains navigateurs ne coupent le flux WebRTC lors de la mise en veille.
- Mise à jour du fichier `listen.html` pour intégrer ces nouvelles fonctionnalités.

## Retour d'expérience et guide technique

Lors de nos dernières vélorutions, un besoin revenait systématiquement : diffuser de la musique depuis le char tout en permettant aux participant·es d'utiliser leurs propres enceintes Bluetooth. L'objectif était simple : obtenir une ambiance sonore homogène, sans échos, sans décalages, et surtout sans avoir à trimballer une sono trop lourde.

Après avoir testé plusieurs pistes, comme le Bluetooth ou la diffusion FM, j'ai finalement opté pour une solution WebRTC basée sur LiveKit, qui semble étonnamment efficace.

Ce qui suit est le récit technique du montage, accompagné de notes, pièges évités et résultats concrets après plusieurs jours de tests, avant de passer aux tests sur le terrain.



## 1. Principe général

**L'idée :**
- Diffuser l'audio dans une Room LiveKit
- Laisser les participant·es se connecter via une simple page web
- Synchroniser la lecture sur tous les appareils via une mécanique maison utilisant `playbackRate`

Contrairement à un live classique (HLS, Icecast ou autre), l'objectif n'est pas seulement de réduire la latence, mais de **garantir la même latence pour tout le monde**.

WebRTC, aidé d'un SFU comme LiveKit, est parfait pour ça.



## 2. Architecture technique

L'architecture se découpe en trois blocs :

### **LiveKit Server**
Service principal qui gère :
- les Rooms
- les pistes audio
- la transmission en temps réel
- le modèle SFU (Selective Forwarding Unit), qui évite la surcharge du serveur

LiveKit tourne chez moi sous Linux, avec un accès WebSocket exposé via proxy Apache.

### **Serveur de tokens**
Micro-service simple (en Node.js) chargé de créer :
- des "join tokens" pour les clients
- des autorisations limitées dans le temps

Il est volontairement séparé de LiveKit pour une meilleure sécurité et un déploiement plus flexible.

### **Page web "listener"**
Une page très légère contenant :
- le client LiveKit
- un player audio HTML5
- une boucle de synchronisation basée sur un signal partagé (via DataChannel ou via un timestamp commun)

Chaque téléphone se contente :
- de récupérer le flux audio WebRTC
- de l'envoyer vers son enceinte Bluetooth
- de s'auto-corriger en permanence pour rester parfaitement calé sur le tempo



## 3. Ce qui surprend quand on monte ce système

### **WebRTC n'aime pas l'audio pur**
La plupart des tutos LiveKit concernent la vidéo. Pour l'audio pur, il faut désactiver plusieurs optimisations inutiles (AEC, AGC, etc.) pour éviter que le son soit transformé.

### **Bluetooth ajoute un décalage… mais stable**
Les enceintes Bluetooth ont en général une latence fixe 200ms (mais legerement différente d'un modèle à l'autre).  
C'est justement cette constance qui permet de compenser de manière fiable via `playbackRate`.

### **La synchro demande de la finesse**
J'ai testé plusieurs stratégies :
- lecture par timestamp WebRTC → trop imprécis
- ajustement continu du `currentTime` → provoque des sauts audibles
- micro-ajustement du `playbackRate` → la solution la plus propre

Avec un ajustement de ±2 %, tout reste audible et la synchronisation est parfaite.



## 4. Déploiement : rôle crucial du proxy

Le proxy Apache assure :
- la redirection WebSocket (`/livekit`)
- l'accès HTTPS
- l'isolation des ports internes



## 5. Prêt à mettre les mains dans le cambouis ?

### **Mes prérequis**
- Un site qui tourne (perso sous Apache2, mais ça fonctionne aussi avec Nginx)
- NodeJS pour le serveur de tokens

### **Installation de LiveKit**
Côté serveur, j'ai installé LiveKit assez simplement grâce à la documentation officielle :  
https://github.com/livekit/livekit
J'ai utilisé la commande :
```bash
curl -sSL https://get.livekit.io
```  
J'ai ensuite créé un dossier livekit dans mon `/home` Dans ce dossier, j'ai d'abord créé le fichier de configuration `livekit.yaml` :  
```yaml
bind_addresses:
  - "0.0.0.0"

rtc:
  tcp_port: 8443
  udp_port: 7880

keys:
  clé-api: "ma-clé-super-secrete"

log_level: info  
```
je crée ensuite le fichier `package.json` pour l'installation des dépendances Nodejs via NPM.  
```
{
  "name": "livekit",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "livekit-server-sdk": "^2.13.3"
  }
}
```  
Puis j'installe les dépendances :  
```bash
npm install
```  

### **Service Systemd pour LiveKit**  
Puis j'ai créé un fichier de service dans `/etc/systemd/system/livekit.service` :  
```
[Unit]
Description=LiveKit Server
After=network.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /home/K0d/livekit/livekit.yaml
Restart=on-failure
User=k0d
WorkingDirectory=/home/k0d/livekit/

[Install]
WantedBy=multi-user.target
```  

Je rafraîchis systemd pour prendre en compte ce service :  
```bash  
sudo systemctl daemon-reload
```

Puis je démarre le service :  
```bash  
sudo systemctl start livekit
```

### **Serveur de tokens**  
Pour les connexions, j'ai aussi besoin d'un serveur de tokens, indispensable pour accéder à ma room LiveKit.  
J'ai donc créé un mini-serveur Node.js pour générer dynamiquement les tokens sans exposer ma clé.  
Dans mon dossier `/home/k0d/livekit`, j'ai créé un fichier `server.mjs` :
```javascript
// server.mjs
import express from 'express';
import cors from 'cors';
import { AccessToken } from 'livekit-server-sdk';

const app = express();
app.use(cors());

const API_KEY = 'clé-api';
const API_SECRET = 'ma-clé-super-secrete';

app.get('/token', async (req, res) => {
  const roomName = req.query.room ?? 'room1';
  const identity = req.query.identity ?? 'user';

  const at = new AccessToken(API_KEY, API_SECRET, { identity });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    audio: true,
    video: false
  });

  const jwt = await at.toJwt();
  res.json({ token: jwt });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Token server listening on http://localhost:${PORT}`);
});
```  

Je crée ensuite un service systemd  
 ```bash  
sudo nano /etc/systemd/system/livekit-token.service
```
et j'y entre :
```
[Unit]
Description=LiveKit Token Server
After=network.target

[Service]
Type=simple
User=k0d
WorkingDirectory=/home/k0d/livekit
ExecStart=/usr/bin/node /home/k0d/livekit/server.mjs
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
je recharche systemd:  
```bash  
sudo systemctl daemon-reload
```
puis lance mon service:
```bash  
sudo systemctl start livekit-token
```
Pour le moment, je préfère séparer mes services pour faciliter le debug, mais je pourrai les réunir plus tard dans un seul service.

Je ne les active pas non plus par défaut (systemctl enable), car je veux pouvoir les lancer uniquement lors des vélorutions. 
  
### **Exposition au Web via Apache2**  
Pour rendre mes services accessibles sur Internet, j'ai édité la config de mon site Apache2 dans `/etc/apache2/sites-available`.

J'y ai ajouté, avant `</VirtualHost>` :  
```# Proxy pour LiveKit 
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule ^/livekit/(.*) ws://127.0.0.1:7880/$1 [P,L]

ProxyPass /livekit/ http://127.0.0.1:7880/
ProxyPassReverse /livekit/ http://127.0.0.1:7880/

# Proxy vers Node.js token server
ProxyPass /token http://127.0.0.1:3000/token
ProxyPassReverse /token http://127.0.0.1:3000/token
```

et rechargé Apache2:
```bash
sudo systemctl reload apache2
```
Ainsi :  

- LiveKit est disponible à : https://velorutionsaintnazaire.fr/livekit

- Les tokens à : https://velorutionsaintnazaire.fr/token  

### **Page d'émission : emit.html**  

La page emit.html, qui servira, comme son nom l’indique, à émettre le son, permet, en deux ou trois clics, de lancer l’émission et de choisir la source sonore.

la page est sur mon [github ici](https://github.com/kodcast/webRTCLiveKitradiosimple/blob/main/emit.html).  

Avec cette page, j’utilise un CDN pour inclure le client. Cependant, vous pouvez — et devriez — le mettre en local.  

Vous remarquerez qu’il y a énormément de lignes commentées : je les laisse volontairement, car elles sont utiles pour le traitement du son (« source → EQ → gain → destination »).  
Ici, je contourne l’EQ pour faire simplement « source → gain → destination ». Mon gain étant à 1, son utilité reste limitée, mais je pense augmenter un peu le volume de la source, car le son est assez faible en l’état.  
Bien sûr, je vous recommande de personnaliser votre page à l’aide de CSS.

### **Page d'écoute : listen.html**
La page listen.html est ici sur mon [github](https://github.com/kodcast/webRTCLiveKitradiosimple/blob/main/listen.html).  
Là encore j'utilise LiveKit côté client, via CDN.  

La partie la plus importante est la synchronisation du flux audio :
```javascript
const maxDrift = 0.01; // 10ms de drift max (ne pas descendre plus bas 30 voir plus est bien plus raisonnable)
const smoothFactor = 0.05; // correction progressive via playbackRate
```
Ce système ajuste la vitesse du son pour rattraper un retard ou un décalage réseau.
L'effet est surprenant : le flux accélère ou ralentit légèrement, exactement comme un DJ qui rattrape un tempo.  
## Conclusion

Ce système fonctionne très bien en situation réelle :
latence faible, synchronisation correcte, compatibilité totale avec des enceintes Bluetooth, simples smartphones, etc.

J'espère que ça pourra vous être utile.
À bientôt sur les vélorutions,

Kod.
