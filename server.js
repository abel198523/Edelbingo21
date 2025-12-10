require('dotenv').config();
const express = require('express');
const http = require('http'); // ✅ የተስተካከለ
const WebSocket = require('ws'); 
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api'); 

const db = require('./db/database');
const User = require('./models/User');
const Wallet = require('./models/Wallet');
const Game = require('./models/Game');
const { validateBingo } = require('./data/cards');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const app = express();

// ✅ Body parser MUST come first before any routes
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Telegram Bot Logic Added ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_SERVER_URL = process.env.RENDER_SERVER_URL;
const MINI_APP_URL = process.env.MINI_APP_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS}` : null);

// Always use polling mode for development
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: true
});

bot.getMe().then((botInfo) => {
    console.log("Bot running in Polling mode.");
    console.log("Bot username:", botInfo.username);
    console.log("Bot ID:", botInfo.id);
    if (MINI_APP_URL) {
        console.log(`Mini App URL: ${MINI_APP_URL}`);
    }
}).catch((err) => {
    console.error("Failed to get bot info:", err.message);
});

// Handle the /start command
bot.onText(/\/start/, async (msg) => {
    console.log('Received /start command from:', msg.from.id);
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    
    // Check if user is already registered
    let isRegistered = false;
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
        isRegistered = result.rows.length > 0;
    } catch (err) {
        console.error('Error checking user:', err);
    }
    
    const miniAppUrlWithId = MINI_APP_URL ? `${MINI_APP_URL}?tg_id=${telegramId}` : null;
    
    if (isRegistered && miniAppUrlWithId) {
        // User is registered - show Register, Play and Check Balance buttons
        bot.sendMessage(chatId, "እንኳን ደህና መጡ! ጨዋታውን ለመጀመር 'Play' የሚለውን ቁልፍ ይጫኑ።", {
            reply_markup: {
                keyboard: [
                    [{ text: "📱 Register", request_contact: true }],
                    [{ text: "▶️ Play", web_app: { url: miniAppUrlWithId } }],
                    [{ text: "💰 Check Balance" }]
                ],
                resize_keyboard: true
            }
        });
    } else {
        // User is not registered or no Mini App URL - show Register button
        bot.sendMessage(chatId, "እንኳን ደህና መጡ ወደ ችዋታቢንጎ! 🎉\n\nለመመዝገብ እና 10 ብር ቦነስ ለማግኘት ስልክ ቁጥርዎን ያጋሩ።", {
            reply_markup: {
                keyboard: [
                    [{ text: "📱 Register", request_contact: true }]
                ],
                resize_keyboard: true
            }
        });
    }
});

// Handle contact sharing for registration
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const contact = msg.contact;
    const telegramId = contact.user_id;
    const phoneNumber = contact.phone_number;
    const miniAppUrlWithId = MINI_APP_URL ? `${MINI_APP_URL}?tg_id=${telegramId}` : null;
    
    try {
        // Check if already registered
        const existingUser = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
        
        if (existingUser.rows.length > 0) {
            bot.sendMessage(chatId, "እርስዎ ቀድሞ ተመዝግበዋል! 'Play' ን ይጫኑ።", {
                reply_markup: {
                    keyboard: [
                        [{ text: "📱 Register", request_contact: true }],
                        [{ text: "▶️ Play", web_app: { url: miniAppUrlWithId } }],
                        [{ text: "💰 Check Balance" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }
        
        // Register new user with 10 ETB bonus
        const username = msg.from.username || `Player_${telegramId}`;
        const userResult = await pool.query(
            'INSERT INTO users (telegram_id, username, phone_number, is_registered) VALUES ($1, $2, $3, $4) RETURNING id',
            [telegramId, username, phoneNumber, true]
        );
        
        // Create wallet with 10 ETB bonus
        const userId = userResult.rows[0].id;
        await pool.query(
            'INSERT INTO wallets (user_id, balance) VALUES ($1, $2)',
            [userId, 10.00]
        );
        
        console.log(`New user registered: ${telegramId} - ${phoneNumber}`);
        
        bot.sendMessage(chatId, "✅ በተሳካ ሁኔታ ተመዝግበዋል!\n\n🎁 10 ብር የእንኳን ደህና መጡ ቦነስ አግኝተዋል!\n\nአሁን 'Play' ን ይጫኑ!", {
            reply_markup: {
                keyboard: [
                    [{ text: "📱 Register", request_contact: true }],
                    [{ text: "▶️ Play", web_app: { url: miniAppUrlWithId } }],
                    [{ text: "💰 Check Balance" }]
                ],
                resize_keyboard: true
            }
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        bot.sendMessage(chatId, "ይቅርታ፣ በመመዝገብ ላይ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።");
    }
});

// Handle Check Balance button
bot.onText(/💰 Check Balance/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    
    try {
        const result = await pool.query(
            'SELECT w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1',
            [telegramId]
        );
        
        if (result.rows.length > 0) {
            const balance = parseFloat(result.rows[0].balance).toFixed(2);
            bot.sendMessage(chatId, `💰 የእርስዎ ቀሪ ሒሳብ: ${balance} ብር`);
        } else {
            bot.sendMessage(chatId, "እባክዎ መጀመሪያ ይመዝገቡ። /start ይላኩ።");
        }
    } catch (error) {
        console.error('Balance check error:', error);
        bot.sendMessage(chatId, "ይቅርታ፣ ሒሳብዎን ማግኘት አልተቻለም።");
    }
});

bot.on('polling_error', (error) => {
    console.error("Polling error:", error.code, error.message);
});

bot.on('error', (error) => {
    console.error("Bot error:", error.message);
});

// --- End of Telegram Bot Logic ---

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'chewatabingo-secret-key-change-in-production';
const SELECTION_TIME = 45;
const WINNER_DISPLAY_TIME = 5;

let currentGameId = null;
let gameState = {
    phase: 'selection',
    timeLeft: SELECTION_TIME,
    calledNumbers: [],
    masterNumbers: [],
    winner: null,
    players: new Map(),
    stakeAmount: 10
};

let playerIdCounter = 0;

function initializeMasterNumbers() {
    gameState.masterNumbers = [];
    for (let i = 1; i <= 75; i++) {
        gameState.masterNumbers.push(i);
    }
    gameState.calledNumbers = [];
}

function getLetterForNumber(num) {
    if (num >= 1 && num <= 15) return 'B';
    if (num >= 16 && num <= 30) return 'I';
    if (num >= 31 && num <= 45) return 'N';
    if (num >= 46 && num <= 60) return 'G';
    if (num >= 61 && num <= 75) return 'O';
    return '';
}

function callNumber() {
    const uncalledNumbers = gameState.masterNumbers.filter(
        num => !gameState.calledNumbers.includes(num)
    );
    
    if (uncalledNumbers.length === 0) {
        return null;
    }
    
    const randomIndex = Math.floor(Math.random() * uncalledNumbers.length);
    const calledNumber = uncalledNumbers[randomIndex];
    gameState.calledNumbers.push(calledNumber);
    
    return {
        number: calledNumber,
        letter: getLetterForNumber(calledNumber)
    };
}

function broadcast(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function getConfirmedPlayersCount() {
    let count = 0;
    gameState.players.forEach((player) => {
        if (player.isCardConfirmed) {
            count++;
        }
    });
    return count;
}

async function startSelectionPhase() {
    gameState.phase = 'selection';
    gameState.timeLeft = SELECTION_TIME;
    gameState.winner = null;
    gameState.calledNumbers = [];
    
    gameState.players.forEach((player, id) => {
        player.selectedCardId = null;
        player.isCardConfirmed = false;
    });
    
    try {
        const game = await Game.create(gameState.stakeAmount);
        currentGameId = game.id;
        console.log(`New game created: #${currentGameId}`);
    } catch (err) {
        console.error('Error creating game:', err);
    }
    
    broadcast({
        type: 'phase_change',
        phase: 'selection',
        timeLeft: gameState.timeLeft,
        gameId: currentGameId
    });
}

function startGamePhase() {
    gameState.phase = 'game';
    gameState.timeLeft = -1;
    initializeMasterNumbers();
    
    broadcast({
        type: 'phase_change',
        phase: 'game',
        timeLeft: -1,
        players: getPlayersInfo()
    });
}

async function startWinnerDisplay(winnerInfo) {
    stopNumberCalling();
    gameState.phase = 'winner';
    gameState.timeLeft = WINNER_DISPLAY_TIME;
    gameState.winner = winnerInfo;
    
    try {
        if (currentGameId && winnerInfo.userId) {
            const game = await Game.setWinner(
                currentGameId, 
                winnerInfo.userId, 
                winnerInfo.cardId,
                gameState.calledNumbers
            );
            
            if (game && game.total_pot > 0) {
                await Wallet.win(winnerInfo.userId, game.total_pot, currentGameId);
                winnerInfo.prize = game.total_pot;
                
                // Send real-time balance update to the winner
                const newBalance = await Wallet.getBalance(winnerInfo.userId);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        const player = gameState.players.get(client.playerId);
                        if (player && player.userId === winnerInfo.userId) {
                            client.send(JSON.stringify({
                                type: 'balance_update',
                                balance: parseFloat(newBalance),
                                prize: game.total_pot
                            }));
                        }
                    }
                });
            }
        }
    } catch (err) {
        console.error('Error recording winner:', err);
    }
    
    broadcast({
        type: 'phase_change',
        phase: 'winner',
        timeLeft: gameState.timeLeft,
        winner: winnerInfo
    });
}

function getPlayersInfo() {
    const players = [];
    gameState.players.forEach((player, id) => {
        if (player.isCardConfirmed) {
            players.push({
                id: id,
                username: player.username,
                cardId: player.selectedCardId
            });
        }
    });
    return players;
}

let numberCallInterval = null;

function startNumberCalling() {
    if (numberCallInterval) clearInterval(numberCallInterval);
    
    numberCallInterval = setInterval(() => {
        if (gameState.phase === 'game') {
            const call = callNumber();
            if (call) {
                broadcast({
                    type: 'number_called',
                    number: call.number,
                    letter: call.letter,
                    calledNumbers: gameState.calledNumbers
                });
            } else {
                stopNumberCalling();
                broadcast({
                    type: 'all_numbers_called'
                });
                setTimeout(() => {
                    if (gameState.phase === 'game') {
                        startSelectionPhase();
                    }
                }, 5000);
            }
        }
    }, 3000);
}

function stopNumberCalling() {
    if (numberCallInterval) {
        clearInterval(numberCallInterval);
        numberCallInterval = null;
    }
}

async function gameLoop() {
    if (gameState.phase === 'game') {
        return;
    }
    
    gameState.timeLeft--;
    
    broadcast({
        type: 'timer_update',
        phase: gameState.phase,
        timeLeft: gameState.timeLeft
    });
    
    if (gameState.timeLeft <= 0) {
        if (gameState.phase === 'selection') {
            const confirmedPlayers = getConfirmedPlayersCount();
            
            if (confirmedPlayers >= 1) {
                startGamePhase();
                startNumberCalling();
            } else {
                await startSelectionPhase();
            }
        } else if (gameState.phase === 'winner') {
            await startSelectionPhase();
        }
    }
}

wss.on('connection', (ws) => {
    const playerId = ++playerIdCounter;
    const player = {
        id: playerId,
        userId: null,
        username: 'Guest_' + playerId,
        selectedCardId: null,
        isCardConfirmed: false,
        balance: 0
    };
    gameState.players.set(playerId, player);
    
    ws.playerId = playerId;
    
    ws.send(JSON.stringify({
        type: 'init',
        playerId: playerId,
        phase: gameState.phase,
        timeLeft: gameState.timeLeft,
        calledNumbers: gameState.calledNumbers,
        winner: gameState.winner,
        gameId: currentGameId
    }));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const player = gameState.players.get(playerId);
            
            switch (data.type) {
                case 'auth_telegram':
                    try {
                        const user = await User.findOrCreateByTelegram(
                            data.telegramId,
                            data.username
                        );
                        player.userId = user.id;
                        player.username = user.username;
                        player.balance = parseFloat(user.balance || 0);
                        
                        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
                        
                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            token: token,
                            user: {
                                id: user.id,
                                username: user.username,
                                balance: player.balance
                            }
                        }));
                    } catch (err) {
                        console.error('Auth error:', err);
                        ws.send(JSON.stringify({ type: 'auth_error', error: 'Authentication failed' }));
                    }
                    break;

                case 'auth_token':
                    try {
                        const decoded = jwt.verify(data.token, JWT_SECRET);
                        const user = await User.findById(decoded.userId);
                        
                        if (user) {
                            player.userId = user.id;
                            player.username = user.username;
                            player.balance = parseFloat(user.balance || 0);
                            
                            ws.send(JSON.stringify({
                                type: 'auth_success',
                                user: {
                                    id: user.id,
                                    username: user.username,
                                    balance: player.balance
                                }
                            }));
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
                    }
                    break;

                case 'register':
                    try {
                        const existingUser = await User.findByUsername(data.username);
                        if (existingUser) {
                            ws.send(JSON.stringify({ type: 'register_error', error: 'Username taken' }));
                            break;
                        }
                        
                        const newUser = await User.create(data.username, data.password);
                        player.userId = newUser.id;
                        player.username = newUser.username;
                        player.balance = 0;
                        
                        const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
                        
                        ws.send(JSON.stringify({
                            type: 'register_success',
                            token: token,
                            user: {
                                id: newUser.id,
                                username: newUser.username,
                                balance: 0
                            }
                        }));
                    } catch (err) {
                        console.error('Register error:', err);
                        ws.send(JSON.stringify({ type: 'register_error', error: 'Registration failed' }));
                    }
                    break;

                case 'login':
                    try {
                        const user = await User.findByUsername(data.username);
                        if (!user || !(await User.verifyPassword(user, data.password))) {
                            ws.send(JSON.stringify({ type: 'login_error', error: 'Invalid credentials' }));
                            break;
                        }
                        
                        player.userId = user.id;
                        player.username = user.username;
                        player.balance = parseFloat(user.balance || 0);
                        await User.updateLastLogin(user.id);
                        
                        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
                        
                        ws.send(JSON.stringify({
                            type: 'login_success',
                            token: token,
                            user: {
                                id: user.id,
                                username: user.username,
                                balance: player.balance
                            }
                        }));
                    } catch (err) {
                        console.error('Login error:', err);
                        ws.send(JSON.stringify({ type: 'login_error', error: 'Login failed' }));
                    }
                    break;
                    
                case 'set_username':
                    if (gameState.players.has(playerId)) {
                        gameState.players.get(playerId).username = data.username;
                    }
                    break;
                    
                case 'select_card':
                    if (gameState.phase === 'selection' && gameState.players.has(playerId)) {
                        gameState.players.get(playerId).selectedCardId = data.cardId;
                    }
                    break;
                    
                case 'confirm_card':
                    if (gameState.phase === 'selection' && player) {
                        if (!player.userId) {
                            ws.send(JSON.stringify({ 
                                type: 'error', 
                                error: 'Please login first' 
                            }));
                            break;
                        }
                        
                        // Use cardId from message data if player hasn't selected yet
                        const cardIdToConfirm = data.cardId || player.selectedCardId;
                        
                        if (cardIdToConfirm) {
                            player.selectedCardId = cardIdToConfirm;
                            
                            // Note: Stake is already deducted via /api/bet, just confirm the card
                            player.isCardConfirmed = true;
                            
                            try {
                                await Game.addParticipant(
                                    currentGameId,
                                    player.userId,
                                    cardIdToConfirm,
                                    gameState.stakeAmount
                                );
                            } catch (err) {
                                console.error('Error adding participant:', err);
                            }
                            
                            // Get updated balance
                            const balance = await Wallet.getBalance(player.userId);
                            player.balance = parseFloat(balance);
                            
                            ws.send(JSON.stringify({
                                type: 'card_confirmed',
                                cardId: cardIdToConfirm,
                                balance: player.balance
                            }));
                        }
                    }
                    break;
                    
                case 'claim_bingo':
                    if (gameState.phase === 'game' && player) {
                        if (player.isCardConfirmed && player.selectedCardId) {
                            // Server-side validation - don't trust client isValid
                            const isValidBingo = validateBingo(player.selectedCardId, gameState.calledNumbers);
                            
                            if (isValidBingo) {
                                startWinnerDisplay({
                                    userId: player.userId,
                                    username: player.username,
                                    cardId: player.selectedCardId
                                });
                            } else {
                                ws.send(JSON.stringify({
                                    type: 'bingo_rejected',
                                    error: 'ቢንጎ ትክክል አይደለም'
                                }));
                            }
                        }
                    }
                    break;

                case 'get_balance':
                    if (player.userId) {
                        try {
                            const balance = await Wallet.getBalance(player.userId);
                            player.balance = parseFloat(balance);
                            ws.send(JSON.stringify({
                                type: 'balance_update',
                                balance: player.balance
                            }));
                        } catch (err) {
                            console.error('Balance error:', err);
                        }
                    }
                    break;

                case 'get_transactions':
                    if (player.userId) {
                        try {
                            const transactions = await Wallet.getTransactionHistory(player.userId);
                            ws.send(JSON.stringify({
                                type: 'transactions',
                                transactions: transactions
                            }));
                        } catch (err) {
                            console.error('Transactions error:', err);
                        }
                    }
                    break;

                case 'get_game_history':
                    if (player.userId) {
                        try {
                            const history = await Game.getUserGameHistory(player.userId);
                            const stats = await Game.getUserStats(player.userId);
                            ws.send(JSON.stringify({
                                type: 'game_history',
                                history: history,
                                stats: stats
                            }));
                        } catch (err) {
                            console.error('Game history error:', err);
                        }
                    }
                    break;

                case 'deposit':
                    if (player.userId && data.amount > 0) {
                        try {
                            const result = await Wallet.deposit(player.userId, data.amount);
                            if (result.success) {
                                player.balance = result.balance;
                                ws.send(JSON.stringify({
                                    type: 'deposit_success',
                                    balance: result.balance
                                }));
                            }
                        } catch (err) {
                            ws.send(JSON.stringify({ type: 'deposit_error', error: 'Deposit failed' }));
                        }
                    }
                    break;
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });
    
    ws.on('close', () => {
        gameState.players.delete(playerId);
    });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const existingUser = await User.findByUsername(username);
        if (existingUser) {
            return res.status(400).json({ error: 'Username already taken' });
        }
        
        const user = await User.create(username, password);
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            token, 
            user: { id: user.id, username: user.username, balance: 0 } 
        });
    } catch (err) {
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await User.findByUsername(username);
        if (!user || !(await User.verifyPassword(user, password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        await User.updateLastLogin(user.id);
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            token, 
            user: { id: user.id, username: user.username, balance: user.balance } 
        });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { userId, phoneNumber } = req.body;
        
        if (!userId || !phoneNumber) {
            return res.status(400).json({ success: false, message: 'userId and phoneNumber are required' });
        }

        const telegramId = parseInt(userId) || 0;
        
        const existingUser = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (existingUser.rows.length > 0) {
            return res.json({ success: false, message: 'User already registered.' });
        }

        const username = 'Player_' + telegramId;
        const userResult = await pool.query(
            `INSERT INTO users (telegram_id, username, phone_number, is_registered) 
             VALUES ($1, $2, $3, TRUE) RETURNING id`,
            [telegramId, username, phoneNumber]
        );

        const newUserId = userResult.rows[0].id;
        
        await pool.query(
            `INSERT INTO wallets (user_id, balance, currency) 
             VALUES ($1, 10.00, 'ETB')`,
            [newUserId]
        );

        res.json({ success: true, message: 'Registration successful. 10 ETB welcome bonus added.' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

app.get('/api/check-registration/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const tgId = parseInt(telegramId) || 0;
        
        const result = await pool.query(
            'SELECT id, is_registered FROM users WHERE telegram_id = $1',
            [tgId]
        );

        if (result.rows.length === 0) {
            return res.json({ registered: false });
        }

        res.json({ registered: result.rows[0].is_registered || false });
    } catch (err) {
        console.error('Check registration error:', err);
        res.json({ registered: false });
    }
});

app.get('/api/profile/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const tgId = parseInt(telegramId) || 0;
        
        const userResult = await pool.query(
            `SELECT u.id, u.username, u.telegram_id, u.phone_number, u.is_registered, u.created_at, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.telegram_id = $1`,
            [tgId]
        );

        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: 'User not found' });
        }

        const user = userResult.rows[0];
        
        const gamesResult = await pool.query(
            `SELECT COUNT(*) as total_games FROM game_participants WHERE user_id = $1`,
            [user.id]
        );
        
        const winsResult = await pool.query(
            `SELECT COUNT(*) as wins FROM games WHERE winner_id = $1`,
            [user.id]
        );

        res.json({
            success: true,
            profile: {
                username: user.username || 'Player',
                telegramId: user.telegram_id,
                phoneNumber: user.phone_number || '---',
                balance: parseFloat(user.balance) || 0,
                totalGames: parseInt(gamesResult.rows[0].total_games) || 0,
                wins: parseInt(winsResult.rows[0].wins) || 0,
                memberSince: user.created_at
            }
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ success: false, message: 'Failed to load profile' });
    }
});

app.get('/api/wallet/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const telegramId = parseInt(userId) || 0;
        
        const result = await pool.query(
            `SELECT u.id, u.is_registered, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.telegram_id = $1`,
            [telegramId]
        );

        if (result.rows.length === 0) {
            return res.json({ 
                balance: 0, 
                is_registered: false,
                stake: 10
            });
        }

        const user = result.rows[0];
        res.json({ 
            balance: parseFloat(user.balance) || 0, 
            is_registered: user.is_registered || false,
            stake: 10
        });
    } catch (err) {
        console.error('Wallet error:', err);
        res.status(500).json({ balance: 0, is_registered: false, stake: 10 });
    }
});

app.post('/api/bet', async (req, res) => {
    try {
        const { userId, stakeAmount } = req.body;
        
        if (!userId || !stakeAmount) {
            return res.status(400).json({ success: false, message: 'userId and stakeAmount are required' });
        }

        const telegramId = parseInt(userId) || 0;

        const userResult = await pool.query(
            'SELECT u.id, w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: 'User not found' });
        }

        const internalUserId = userResult.rows[0].id;
        const currentBalance = parseFloat(userResult.rows[0].balance) || 0;
        
        if (currentBalance < stakeAmount) {
            return res.json({ success: false, message: 'Insufficient balance' });
        }

        const newBalance = currentBalance - stakeAmount;
        
        await pool.query(
            'UPDATE wallets SET balance = $1 WHERE user_id = $2',
            [newBalance, internalUserId]
        );

        res.json({ success: true, balance: newBalance });
    } catch (err) {
        console.error('Bet error:', err);
        res.status(500).json({ success: false, message: 'Bet failed' });
    }
});

const PORT = process.env.PORT || 10000;

async function startServer() {
    try {
        await db.initializeDatabase();
        console.log('Database initialized');
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT}`);
            console.log('WebSocket server ready');
            
            initializeMasterNumbers();
            startSelectionPhase();
            setInterval(gameLoop, 1000);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        
        // Fallback to start server without database connection logic
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT} (without database)`);
            console.log('WebSocket server ready');
            
            initializeMasterNumbers();
            startSelectionPhase();
            setInterval(gameLoop, 1000);
        });
    }
}

startServer();
