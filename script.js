import { Room } from 'https://cdn.jsdelivr.net/npm/livekit-client@2.5.1/dist/livekit-client.esm.mjs';

const listenBtn = document.getElementById('listenBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const hiddenAudio = document.getElementById('hiddenAudio'); // L'Ancre (Reçoit le vrai silence.mp3)

// Élément audio LiveKit global
const livekitAudio = document.createElement('audio');
livekitAudio.playsInline = true;
document.body.appendChild(livekitAudio);

const LIVEKIT_URL = "wss://livekit.velorutionsaintnazaire.fr";
let room = null;
let networkPingInterval = null;
let wakeLock = null; // Stockage du Wake Lock

// ---------- GESTION DU WAKE LOCK (Écran Allumé) ----------
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    console.log('🛡️ Wake Lock activé : l\'écran restera allumé.');
    
    // Si l'utilisateur change d'onglet et revient, l'OS coupe le wake lock. On le réactive ici :
    document.addEventListener('visibilitychange', handleVisibilityChange);
  } catch (err) {
    console.error(`Impossible d'activer le Wake Lock : ${err.message}`);
  }
}

async function releaseWakeLock() {
  try {
    if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      console.log('🔓 Wake Lock libéré.');
    }
  } catch (err) {
    console.error("Erreur libération Wake Lock", err);
  }
}

async function handleVisibilityChange() {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    wakeLock = await navigator.wakeLock.request('screen');
    console.log('🛡️ Wake Lock réactivé après retour sur la page.');
  }
}

// ---------- MEDIA SESSION (Contrôles Écran de Verrouillage) ----------
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;

  const artworkUrl = window.location.origin + '../logo.png';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: "Flux Vélorutionnaire",
    artist: "En direct",
    album: "Radio Live",
    artwork: [{ src: artworkUrl, sizes: "512x512", type: "image/png" }]
  });

  navigator.mediaSession.setActionHandler('play', async () => {
    await hiddenAudio.play();
    livekitAudio.muted = false;
    navigator.mediaSession.playbackState = 'playing';
    statusEl.textContent = "🎵 Diffusion en cours";
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    hiddenAudio.pause();
    livekitAudio.muted = true; // "Mute" pour garder la synchro temps réel du direct
    navigator.mediaSession.playbackState = 'paused';
    statusEl.textContent = "⏸️ En pause";
  });
}

// ---------- PING RÉSEAU AGRESSIF (Anti-veille WiFi/4G) ----------
function startNetworkPing() {
  if (networkPingInterval) clearInterval(networkPingInterval);
  networkPingInterval = setInterval(() => {
    fetch('icon-192.png?t=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
      .catch(e => console.log('Ping réseau arrière-plan', e));
  }, 10000); 
}

function stopNetworkPing() {
  if (networkPingInterval) {
    clearInterval(networkPingInterval);
    networkPingInterval = null;
  }
}

async function getToken() {
  const response = await fetch('/token?room=room1&identity=auditeur_' + Date.now());
  const data = await response.json();
  return data.token;
}

// ---------- CLIC SUR LE BOUTON PLAY ----------
listenBtn.addEventListener('click', async () => {
  listenBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = "Connexion...";
  statusEl.className = "";

  try {
    // 1. Démarrage immédiat des audios (Autorisation du navigateur obtenue)
    hiddenAudio.src = 'silence.mp3';
    hiddenAudio.loop = true;
    hiddenAudio.volume = 0.05; 
    await hiddenAudio.play();

    livekitAudio.src = 'silence.mp3';
    await livekitAudio.play();

    // 2. Activation du Wake Lock pour empêcher l'écran de s'éteindre tout seul
    await requestWakeLock();

    // 3. Configuration des commandes de l'écran de verrouillage
    setupMediaSession();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    // 4. Connexion LiveKit
    const token = await getToken();
    room = new Room({
      reconnectAttempts: 30,
      reconnectTimeout: 3000,
      disconnectOnPageClose: false,
    });

    room
      .on('connected', () => {
        statusEl.textContent = "Connecté, attente du flux...";
      })
      .on('trackSubscribed', async (track) => {
        if (track.kind !== 'audio') return;

        // Injection du flux WebRTC dans notre élément déjà autorisé
        const mediaStream = new MediaStream([track.mediaStreamTrack]);
        livekitAudio.srcObject = mediaStream;
        livekitAudio.muted = false;
        
        await livekitAudio.play().catch(err => console.error("Erreur switch LiveKit", err));

        statusEl.textContent = `🎵 Diffusion en cours`;
        statusEl.className = "playing";
      })
      .on('disconnected', () => {
        cleanUpAll();
      });

    await room.connect(LIVEKIT_URL, token, { autoSubscribe: true });
    startNetworkPing();

  } catch (err) {
    console.error(err);
    statusEl.textContent = "Erreur de connexion";
    statusEl.className = "error";
    cleanUpAll();
  }
});

// ---------- BOUTON STOP ----------
stopBtn.addEventListener('click', () => {
  cleanUpAll();
  statusEl.textContent = "Écoute arrêtée";
});

function cleanUpAll() {
  listenBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.className = "";

  try {
    stopNetworkPing();
    releaseWakeLock(); // Désactivation du Wake Lock à l'arrêt
    
    hiddenAudio.pause();
    hiddenAudio.src = "";
    
    livekitAudio.pause();
    livekitAudio.srcObject = null;
    livekitAudio.src = "";
    
    if (room) room.disconnect();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  } catch (e) {
    console.error("Nettoyage", e);
  }
}
