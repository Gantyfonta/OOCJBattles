
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, set, update, transaction, get, off, runTransaction } from "firebase/database";

// Firebase Configuration (as provided)
const firebaseConfig = {
    apiKey: "AIzaSyBoNeemu9G-sBKPemDxelpCPOuiTZHLyhg",
    authDomain: "gahoot-41e25.firebaseapp.com",
    databaseURL: "https://gahoot-41e25-default-rtdb.firebaseio.com",
    projectId: "gahoot-41e25",
    storageBucket: "gahoot-41e25.firebasestorage.app",
    messagingSenderId: "174472575019",
    appId: "1:174472575019:web:3bd927907334d2ffe1526e",
    measurementId: "G-8QJP2T82VT"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Game Constants
const WIDTH = 400;
const HEIGHT = 700;
const CLOCK_SPACING = 260;
const JUMP_SPEED = 14;
const CLOCK_COLORS = ['#F472B6', '#60A5FA', '#34D399', '#FBBF24', '#A78BFA', '#FB923C'];

const SKINS = [
    { id: 'classic', name: 'Classic Oink', body: '#F472B6', ears: '#EC4899', snout: '#F9A8D4' },
    { id: 'neon', name: 'Neon Hog', body: '#000000', ears: '#3B82F6', snout: '#60A5FA' },
    { id: 'gold', name: 'Gold Swine', body: '#FBBF24', ears: '#D97706', snout: '#FDE68A' },
    { id: 'ghost', name: 'Spectral Pig', body: 'rgba(255,255,255,0.4)', ears: 'rgba(200,200,255,0.3)', snout: 'rgba(255,255,255,0.5)' }
];

const HATS = [
    { id: 'none', name: 'No Hat' },
    { id: 'tophat', name: 'Top Hat' },
    { id: 'viking', name: 'Viking' },
    { id: 'cowboy', name: 'Cowboy' }
];

const THEMES = [
    { id: 'classic', name: 'Neon Night', bg: '#0f172a', type: 'CLOCK' },
    { id: 'noir', name: 'Old Cinema', bg: '#000000', type: 'NOIR' },
    { id: 'synthwave', name: 'Retro Grid', bg: '#1a0b2e', type: 'GRID' },
    { id: 'candy', name: 'Sugar Rush', bg: '#fff1f2', type: 'CANDY' }
];

// State
let state = {
    status: 'HOME',
    isMultiplayer: false,
    roomId: null,
    playerId: null, // 'p1' or 'p2'
    score: 0,
    opponentScore: 0,
    coins: parseInt(localStorage.getItem('oinkCoins') || '0'),
    selectedSkinId: localStorage.getItem('oinkSkin') || 'classic',
    selectedHatId: localStorage.getItem('oinkHatSelected') || 'none',
    selectedThemeId: localStorage.getItem('oinkTheme') || 'classic',
    username: localStorage.getItem('oinkUser') || '',
    pig: { x: 200, y: 550, vx: 0, vy: 0, attachedTo: 0, angle: 0 },
    opponent: { x: 200, y: 550, skin: 'classic', hat: 'none', attachedTo: 0, status: 'playing', score: 0 },
    clocks: [],
    lastClockId: 0,
    cameraY: 0,
    cameraX: 0,
    lastTime: 0,
    rainbowHue: 0
};

// DOM Helpers
const getEl = (id) => document.getElementById(id);
const canvas = getEl('gameCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');

// Audio
let audioCtx;
function initAudio() { if(!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)(); }
function playSound(f) {
    if(!audioCtx) return;
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(f, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    o.start(); o.stop(audioCtx.currentTime + 0.1);
}

function showToast(m, isError = false) {
    const t = document.createElement('div');
    t.className = `toast ${isError ? 'bg-red-500' : 'bg-pink-500'} text-white px-6 py-2 rounded-full font-black text-xs shadow-xl`;
    t.innerText = m;
    getEl('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

// Multiplayer Functions
async function startMatchmaking() {
    if (!state.username) return showUsernameEntry();
    state.status = 'MATCHMAKING';
    getEl('ui-matchmaking').classList.remove('hidden');
    getEl('matchmaking-msg').innerText = "Connecting to time stream...";
    
    const queueRef = ref(db, 'matchmaking_queue');
    
    try {
        const result = await runTransaction(queueRef, (currentQueue) => {
            if (!currentQueue) return { [state.username]: Date.now() };
            // If someone is there, we will join them, so we clear the queue for them (simplified logic)
            return null; 
        });

        if (result.committed) {
            const players = result.snapshot.val();
            if (players === null) {
                // We are P2, joining a host
                getEl('matchmaking-msg').innerText = "Found rival! Joining battle...";
                // Let's find any waiting room
                const roomsSnap = await get(ref(db, 'rooms'));
                let joined = false;
                if (roomsSnap.exists()) {
                    const rooms = roomsSnap.val();
                    for (const rid in rooms) {
                        if (rooms[rid].status === 'waiting') {
                            joinRoom(rid);
                            joined = true;
                            break;
                        }
                    }
                }
                if (!joined) {
                    // Fallback to hosting if no room found
                    waitForOpponent();
                }
            } else {
                // We are P1, hosting
                waitForOpponent();
            }
        }
    } catch (e) {
        console.error(e);
        getEl('ui-matchmaking').classList.add('hidden');
        if (e.message.includes('permission_denied')) {
            showToast("Firebase Error: Permission Denied. Check your Database Rules!", true);
            alert("To fix 'permission_denied', go to Firebase Console > Realtime Database > Rules and set them to:\n{\n  \"rules\": {\n    \".read\": true,\n    \".write\": true\n  }\n}");
        } else {
            showToast("Failed to connect: " + e.message, true);
        }
        state.status = 'HOME';
    }
}

function waitForOpponent() {
    const roomCode = "room_" + state.username + "_" + Math.floor(Math.random()*1000);
    state.roomId = roomCode;
    state.playerId = 'p1';
    
    set(ref(db, 'rooms/' + roomCode), {
        p1: { name: state.username, skin: state.selectedSkinId, hat: state.selectedHatId, x: 200, y: 550, score: 0 },
        status: 'waiting',
        theme: state.selectedThemeId
    });
    
    const statusRef = ref(db, 'rooms/' + roomCode + '/status');
    onValue(statusRef, (snap) => {
        if (snap.val() === 'playing') {
            off(statusRef);
            startBattle(roomCode, 'p1');
        }
    });
}

async function joinRoom(roomCode) {
    state.roomId = roomCode;
    state.playerId = 'p2';
    
    const roomRef = ref(db, 'rooms/' + roomCode);
    const snap = await get(roomRef);
    const data = snap.val();
    
    // Fix shadowing of 'update' by using renamed gameUpdate or referencing the import
    await update(roomRef, {
        p2: { name: state.username, skin: state.selectedSkinId, hat: state.selectedHatId, x: 200, y: 550, score: 0 },
        clocks: generateBattleClocks(),
        status: 'playing'
    });
    
    startBattle(roomCode, 'p2');
}

function generateBattleClocks() {
    let clocks = [];
    clocks.push({ id: 0, x: 200, y: HEIGHT-150, radius: 60, speed: 0.04, color: CLOCK_COLORS[0] });
    for(let i=1; i<100; i++) {
        const radius = 35 + Math.random() * 50;
        clocks.push({
            id: i,
            x: radius + 20 + Math.random() * (WIDTH - radius*2 - 40),
            y: HEIGHT-150-i*CLOCK_SPACING,
            radius: radius,
            speed: (0.04 + (i * 0.0015)) * (60 / radius) * (i % 2 === 0 ? 1 : -1),
            color: CLOCK_COLORS[i % CLOCK_COLORS.length]
        });
    }
    return clocks;
}

function startBattle(roomCode, role) {
    state.status = 'BATTLE_START';
    state.isMultiplayer = true;
    
    getEl('ui-matchmaking').classList.add('hidden');
    getEl('ui-battle-start').classList.remove('hidden');
    
    onValue(ref(db, 'rooms/' + roomCode), (snap) => {
        const data = snap.val();
        if (!data) return;
        
        const oppId = role === 'p1' ? 'p2' : 'p1';
        if (data.clocks) state.clocks = data.clocks;
        if (data.theme) state.selectedThemeId = data.theme;
        
        getEl('p1-name').innerText = data[role].name;
        getEl('p2-name').innerText = data[oppId]?.name || '...';
        
        // Fix getContext error by casting to HTMLCanvasElement
        drawPigAvatar((getEl('p1-preview') as HTMLCanvasElement).getContext('2d'), SKINS.find(s=>s.id===data[role].skin), 32, 32, 1, 0, data[role].hat);
        if (data[oppId]) {
            drawPigAvatar((getEl('p2-preview') as HTMLCanvasElement).getContext('2d'), SKINS.find(s=>s.id===data[oppId].skin), 32, 32, 1, 0, data[oppId].hat);
        }
    }, { onlyOnce: true });

    let count = 3;
    const cd = setInterval(() => {
        count--;
        // Fix number to string assignment
        getEl('battle-countdown').innerText = count > 0 ? count.toString() : "OINK!";
        if (count <= -1) {
            clearInterval(cd);
            getEl('ui-battle-start').classList.add('hidden');
            startGame();
        }
    }, 1000);

    // Live Sync Listener
    const oppId = role === 'p1' ? 'p2' : 'p1';
    onValue(ref(db, 'rooms/' + roomCode + '/' + oppId), (snap) => {
        const d = snap.val();
        if (d) {
            state.opponent.x = d.x;
            state.opponent.y = d.y;
            state.opponent.score = d.score;
            state.opponent.skin = d.skin;
            state.opponent.hat = d.hat;
            state.opponent.status = d.status || 'playing';
            // Fix number to string assignment
            getEl('opponent-score-val').innerText = d.score.toString();
            if (d.status === 'dead' && state.status === 'PLAYING') {
                checkWinner();
            }
        }
    });
}

function startGame() {
    initAudio();
    state.status = 'PLAYING';
    state.score = 0;
    state.cameraY = 0;
    state.cameraX = 0;
    state.lastClockId = 0;
    state.pig = { x: 200, y: HEIGHT-150-60, vx: 0, vy: 0, attachedTo: 0, angle: -Math.PI/2 };
    
    if (!state.isMultiplayer) {
        state.clocks = [{ id: 0, x: 200, y: HEIGHT-150, radius: 60, angle: -Math.PI/2, speed: 0.04, color: CLOCK_COLORS[0] }];
        for(let i=1; i<10; i++) state.clocks.push(createSoloClock(i, HEIGHT-150-i*CLOCK_SPACING, i));
        getEl('opponent-hud').classList.add('hidden');
    } else {
        state.clocks.forEach(c => c.angle = -Math.PI/2);
        getEl('opponent-hud').classList.remove('hidden');
    }
    
    getEl('ui-home').classList.add('hidden');
    getEl('ui-hud').classList.remove('hidden');
    getEl('score-val').innerText = "0";
    refreshUI();
}

function createSoloClock(id, y, index) {
    const radius = 35 + Math.random() * 50;
    return { id, x: radius + 20 + Math.random()*(WIDTH - radius*2 - 40), y, radius, angle: -Math.PI/2, speed: 0.04, color: CLOCK_COLORS[index % CLOCK_COLORS.length] };
}

function jump() {
    if (state.status !== 'PLAYING' || state.pig.attachedTo === null) return;
    const clock = state.clocks.find(c => c.id === state.pig.attachedTo);
    state.pig.vx = Math.cos(clock.angle) * JUMP_SPEED;
    state.pig.vy = Math.sin(clock.angle) * JUMP_SPEED;
    state.pig.attachedTo = null;
    playSound(440);
}

// Rename shadowed function from 'update' to 'gameUpdate'
function gameUpdate(timeScale) {
    if (state.status !== 'PLAYING') return;
    
    state.clocks.forEach(c => c.angle += c.speed * timeScale);

    if (state.pig.attachedTo !== null) {
        const clock = state.clocks.find(c => c.id === state.pig.attachedTo);
        state.pig.x = clock.x + Math.cos(clock.angle) * clock.radius;
        state.pig.y = clock.y + Math.sin(clock.angle) * clock.radius;
    } else {
        state.pig.x += state.pig.vx * timeScale;
        state.pig.y += state.pig.vy * timeScale;
        
        for (const c of state.clocks) {
            const d = Math.sqrt((state.pig.x-c.x)**2 + (state.pig.y-c.y)**2);
            if (d < c.radius + 10) {
                state.pig.attachedTo = c.id;
                if (c.id > state.lastClockId) {
                    state.score += (c.id - state.lastClockId);
                    state.lastClockId = c.id;
                    // Fix number to string assignment
                    getEl('score-val').innerText = state.score.toString();
                }
                playSound(220); break;
            }
        }
        if (state.pig.y > state.cameraY + HEIGHT + 100) gameOver();
    }

    state.cameraY += (state.pig.y - HEIGHT/2 - state.cameraY) * 0.1 * timeScale;
    
    if (state.isMultiplayer) {
        // This now correctly calls Firebase update
        update(ref(db, 'rooms/' + state.roomId + '/' + state.playerId), {
            x: state.pig.x, y: state.pig.y, score: state.score
        });
    } else {
        const last = state.clocks[state.clocks.length-1];
        if (last && last.y > state.cameraY - 400) {
            state.clocks.push(createSoloClock(last.id+1, last.y-CLOCK_SPACING, last.id+1));
        }
    }
}

function gameOver() {
    if (state.isMultiplayer) {
        // This now correctly calls Firebase update
        update(ref(db, 'rooms/' + state.roomId + '/' + state.playerId), { status: 'dead' });
        checkWinner();
    } else {
        state.status = 'GAMEOVER';
        // Fix number to string assignment
        getEl('final-score').innerText = state.score.toString();
        getEl('battle-result').innerText = "GAME OVER";
        getEl('battle-result').className = "text-5xl font-black text-white italic";
        getEl('ui-gameover').classList.remove('hidden');
    }
}

function checkWinner() {
    get(ref(db, 'rooms/' + state.roomId)).then(snap => {
        const data = snap.val();
        if (!data) return;
        const p1 = data.p1; const p2 = data.p2;
        if (p1.status === 'dead' && p2.status === 'dead') {
            const winner = p1.score > p2.score ? p1.name : (p2.score > p1.score ? p2.name : "DRAW");
            showBattleResults(winner);
        } else if (p1.status === 'dead' && state.playerId === 'p2') {
            showBattleResults(state.username);
        } else if (p2.status === 'dead' && state.playerId === 'p1') {
            showBattleResults(state.username);
        }
    });
}

function showBattleResults(winner) {
    state.status = 'GAMEOVER';
    const win = winner === state.username;
    getEl('battle-result').innerText = win ? "VICTORY!" : (winner === "DRAW" ? "DRAW!" : "DEFEATED!");
    getEl('battle-result').className = win ? "text-5xl font-black text-green-400 italic" : "text-5xl font-black text-red-500 italic";
    // Fix number to string assignment
    getEl('final-score').innerText = state.score.toString();
    getEl('ui-gameover').classList.remove('hidden');
}

function drawPigAvatar(pctx, skin, x, y, scale = 1, rotation = 0, hatId = 'none') {
    if (!skin) skin = SKINS[0];
    pctx.save(); pctx.translate(x, y); pctx.scale(scale, scale); pctx.rotate(rotation);
    pctx.fillStyle = skin.body; pctx.beginPath(); pctx.ellipse(0, 0, 18, 16, 0, 0, Math.PI*2); pctx.fill();
    pctx.fillStyle = skin.ears; pctx.beginPath(); pctx.moveTo(-14, -10); pctx.lineTo(-18, -20); pctx.lineTo(-6, -14); pctx.fill();
    pctx.beginPath(); pctx.moveTo(14, -10); pctx.lineTo(18, -20); pctx.lineTo(6, -14); pctx.fill();
    pctx.fillStyle = skin.snout; pctx.beginPath(); pctx.ellipse(0, 4, 8, 6, 0, 0, Math.PI*2); pctx.fill();
    pctx.fillStyle = 'black'; pctx.beginPath(); pctx.arc(-7, -4, 2.5, 0, Math.PI*2); pctx.fill();
    pctx.beginPath(); pctx.arc(7, -4, 2.5, 0, Math.PI*2); pctx.fill();
    
    if (hatId !== 'none') {
        pctx.fillStyle = '#000';
        if (hatId === 'tophat') pctx.fillRect(-10, -25, 20, 15);
        if (hatId === 'viking') { pctx.beginPath(); pctx.arc(0, -12, 10, Math.PI, 0); pctx.fill(); }
        if (hatId === 'cowboy') {
            pctx.fillStyle = '#78350f';
            pctx.beginPath(); pctx.ellipse(0, -12, 15, 4, 0, 0, Math.PI*2); pctx.fill();
            pctx.fillRect(-8, -22, 16, 10);
        }
    }
    pctx.restore();
}

function draw() {
    const theme = THEMES.find(t => t.id === state.selectedThemeId) || THEMES[0];
    ctx.fillStyle = theme.bg; ctx.fillRect(0,0,WIDTH,HEIGHT);
    
    if (theme.id === 'noir') gameContainer.classList.add('noir-mode');
    else gameContainer.classList.remove('noir-mode');

    ctx.save(); ctx.translate(-state.cameraX, -state.cameraY);
    
    // Clocks
    state.clocks.forEach(c => {
        ctx.beginPath(); ctx.arc(c.x, c.y, c.radius, 0, Math.PI*2); ctx.strokeStyle = c.color; ctx.lineWidth = 6; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + Math.cos(c.angle)*c.radius, c.y + Math.sin(c.angle)*c.radius); ctx.strokeStyle = c.color; ctx.lineWidth = 8; ctx.stroke();
    });

    // Self
    const mySkin = SKINS.find(s=>s.id===state.selectedSkinId);
    drawPigAvatar(ctx, mySkin, state.pig.x, state.pig.y, 1, 0, state.selectedHatId);

    // Opponent
    if (state.isMultiplayer) {
        const oppSkin = SKINS.find(s=>s.id===state.opponent.skin);
        ctx.globalAlpha = 0.5;
        drawPigAvatar(ctx, oppSkin, state.opponent.x, state.opponent.y, 1, 0, state.opponent.hat);
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#60A5FA'; ctx.font = '900 12px Inter'; ctx.textAlign = 'center';
        ctx.fillText(state.opponent.score.toString(), state.opponent.x, state.opponent.y - 40);
    }

    ctx.restore();
}

function loop(timestamp) {
    if (!state.lastTime) state.lastTime = timestamp;
    const timeScale = Math.min(timestamp - state.lastTime, 100) / 16.66;
    state.lastTime = timestamp;
    gameUpdate(timeScale);
    draw();
    requestAnimationFrame(loop);
}

// Event Listeners
getEl('btn-battle').onclick = startMatchmaking;
getEl('btn-solo').onclick = () => { state.isMultiplayer = false; startGame(); };
getEl('btn-go-home').onclick = () => location.reload();
getEl('btn-username').onclick = showUsernameEntry;
getEl('btn-save-username').onclick = saveUsername;
getEl('btn-cancel-match').onclick = () => location.reload();

getEl('btn-skins').onclick = openSkins;
getEl('btn-close-skins').onclick = () => getEl('ui-skins').classList.add('hidden');
getEl('btn-hats').onclick = openHats;
getEl('btn-close-hats').onclick = () => getEl('ui-hats').classList.add('hidden');
getEl('btn-themes').onclick = openThemes;
getEl('btn-close-themes').onclick = () => getEl('ui-themes').classList.add('hidden');

function showUsernameEntry() { getEl('ui-username').classList.remove('hidden'); }
function saveUsername() {
    const v = (getEl('username-input') as HTMLInputElement).value.trim();
    if (v.length < 2) return;
    state.username = v; localStorage.setItem('oinkUser', v);
    getEl('ui-username').classList.add('hidden');
    refreshUI();
}

function refreshUI() {
    getEl('home-coins').innerText = state.coins.toString();
    getEl('display-username').innerText = state.username || 'Identify Yourself';
}

function openSkins() {
    const grid = getEl('skins-grid');
    grid.innerHTML = SKINS.map(s => `
        <div data-id="${s.id}" class="card-item border-2 ${state.selectedSkinId === s.id ? 'border-pink-500 bg-pink-500/20' : 'border-white/10'} bg-white/5 p-4 rounded-2xl flex items-center gap-4">
            <div class="w-16 h-16 bg-indigo-900/50 rounded-xl overflow-hidden shrink-0">
                <canvas id="preview-${s.id}" width="64" height="64"></canvas>
            </div>
            <span class="text-sm font-black uppercase">${s.name}</span>
        </div>
    `).join('');
    SKINS.forEach(s => {
        const c = getEl(`preview-${s.id}`) as HTMLCanvasElement;
        drawPigAvatar(c.getContext('2d'), s, 32, 32, 1, 0, 'none');
    });
    grid.querySelectorAll('.card-item').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-id');
            state.selectedSkinId = id;
            localStorage.setItem('oinkSkin', id);
            openSkins();
        });
    });
    getEl('ui-skins').classList.remove('hidden');
}

function openHats() {
    const grid = getEl('hats-grid');
    grid.innerHTML = HATS.map(h => `
        <div data-id="${h.id}" class="card-item border-2 ${state.selectedHatId === h.id ? 'border-pink-500 bg-pink-500/20' : 'border-white/10'} bg-white/5 p-4 rounded-2xl flex items-center gap-4">
            <div class="w-16 h-16 bg-indigo-900/50 rounded-xl overflow-hidden shrink-0">
                <canvas id="hat-preview-${h.id}" width="64" height="64"></canvas>
            </div>
            <span class="text-sm font-black uppercase">${h.name}</span>
        </div>
    `).join('');
    HATS.forEach(h => {
        const c = getEl(`hat-preview-${h.id}`) as HTMLCanvasElement;
        drawPigAvatar(c.getContext('2d'), SKINS[0], 32, 32, 1, 0, h.id);
    });
    grid.querySelectorAll('.card-item').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-id');
            state.selectedHatId = id;
            localStorage.setItem('oinkHatSelected', id);
            openHats();
        });
    });
    getEl('ui-hats').classList.remove('hidden');
}

function openThemes() {
    const grid = getEl('themes-grid');
    grid.innerHTML = THEMES.map(t => `
        <div data-id="${t.id}" class="card-item border-2 ${state.selectedThemeId === t.id ? 'border-pink-500 bg-pink-500/20' : 'border-white/10'} bg-white/5 p-4 rounded-2xl flex items-center gap-4">
            <div class="w-12 h-12 rounded-lg border border-white/20" style="background:${t.bg}"></div>
            <div class="text-left flex-1"><span class="text-sm font-black uppercase">${t.name}</span></div>
        </div>
    `).join('');
    grid.querySelectorAll('.card-item').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-id');
            state.selectedThemeId = id;
            localStorage.setItem('oinkTheme', id);
            openThemes();
        });
    });
    getEl('ui-themes').classList.remove('hidden');
}

canvas.addEventListener('mousedown', () => { initAudio(); jump(); });
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); initAudio(); jump(); });

requestAnimationFrame(loop);
refreshUI();

const gameContainer = getEl('game-container');
