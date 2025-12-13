// api/bot.js
const { Telegraf, Markup } = require('telegraf');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "").split(',').map(id => id.trim()).filter(id => id);

// --- MEMORY STORAGE ---
let userModes = {};     
let batchStorage = {};
let shortenerConfig = {
    domain: process.env.SHORTENER_DOMAIN || "", 
    key: process.env.SHORTENER_KEY || ""
};
let awaitingShortenerConfig = {}; 

// --- HELPERS ---
const encodePayload = (msgId) => {
    const text = `File_${msgId}_Secure`; 
    return Buffer.from(text).toString('base64').replace(/=/g, ''); 
};

const decodePayload = (code) => {
    try {
        const text = Buffer.from(code, 'base64').toString('utf-8');
        const parts = text.split('_');
        if (parts[0] === 'File' && parts[2] === 'Secure') return parseInt(parts[1]);
        return null;
    } catch (e) { return null; }
};

const escapeHTML = (text) => {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

const cleanCaption = (text) => {
    if (!text) return "Untitled File";
    return text
        .replace(/⭕️ Main Channel : @StarFlixTamil ⭕️/g, "")
        .replace(/@[\w_]+/g, "")
        .replace(/(Main Channel|Join Channel).*/gi, "")
        .trim();
};

const getGroupId = (text) => {
    const cleaned = cleanCaption(text);
    const words = cleaned.split(' ').filter(w => w.trim() !== "");
    if (words.length >= 2) return `${words[0]} ${words[1]}`.toLowerCase();
    return words[0] ? words[0].toLowerCase() : "unknown";
};

const getShortLink = async (longUrl) => {
    if (!shortenerConfig.domain || !shortenerConfig.key) return null;
    try {
        const apiUrl = `https://${shortenerConfig.domain}/api?api=${shortenerConfig.key}&url=${encodeURIComponent(longUrl)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.status === 'success' || data.shortenedUrl) return data.shortenedUrl;
        return null;
    } catch (error) {
        console.error("Shortener Error:", error);
        return null;
    }
};

// --- KEYBOARDS ---
const getAdminKeyboard = (mode, count) => {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`🔄 Mode: ${mode.toUpperCase()}`, 'admin_switch')],
        [Markup.button.callback(`⚙️ Setup Shortener`, 'admin_shortener')],
        [Markup.button.callback(`📤 Process Batch (${count})`, 'admin_process')],
        [Markup.button.callback(`❌ Clear Batch`, 'admin_clear')]
    ]);
};

// Button for Single File
const getFileControls = (shortCode) => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✂️ Shorten Link', `shorten_${shortCode}`)]
    ]);
};

// Button for Batch Message (Shorten All)
const getBatchControls = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✂️ Shorten All Links', 'batch_shorten_all')]
    ]);
};

const getJoinButtons = async (ctx, payload) => {
    const buttons = [];
    for (const id of FORCE_SUB_IDS) {
        try {
            const chat = await ctx.telegram.getChat(id);
            const link = chat.invite_link || `https://t.me/${chat.username.replace('@','')}`;
            buttons.push([Markup.button.url(`Join ${chat.title}`, link)]);
        } catch (e) {}
    }
    const cb = payload ? `checksub_${payload}` : 'checksub_home';
    buttons.push([Markup.button.callback('🔄 Verified / Try Again', cb)]);
    return Markup.inlineKeyboard(buttons);
};

// --- ACTIONS & COMMANDS ---

bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    awaitingShortenerConfig[ctx.from.id] = true;
    const current = shortenerConfig.domain ? `✅ Active: ${shortenerConfig.domain}` : "❌ Not Set";
    await ctx.reply(`⚙️ <b>Shortener Config</b>\nStatus: ${current}\n\nSend: <code>domain.com | api_key</code>`, { parse_mode: 'HTML' });
});

// 1. Single Link Shortener
bot.action(/shorten_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');
    const code = ctx.match[1];
    const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
    
    if (!shortenerConfig.domain || !shortenerConfig.key) return ctx.answerCbQuery('⚠️ Setup Shortener first!', { show_alert: true });
    
    await ctx.answerCbQuery('⏳ Shortening...');
    const shortLink = await getShortLink(longLink);
    
    if (shortLink) {
        let newText = ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption || "";
        newText += `\n\n🔗 <b>Original:</b> ${longLink}\n✂️ <b>Short:</b> ${shortLink}`;
        
        try {
            if (ctx.callbackQuery.message.caption) await ctx.editMessageCaption(newText, { parse_mode: 'HTML' });
            else await ctx.editMessageText(newText, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch(e) {}
    } else {
        await ctx.answerCbQuery('❌ API Error.', { show_alert: true });
    }
});

// 2. Batch Link Shortener (NEW FEATURE)
bot.action('batch_shorten_all', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');
    if (!shortenerConfig.domain || !shortenerConfig.key) return ctx.answerCbQuery('⚠️ Setup Shortener first!', { show_alert: true });

    await ctx.answerCbQuery('⏳ Processing all links... This may take time.');
    
    // Get the message text (Batch list)
    let text = ctx.callbackQuery.message.text;
    if (!text) return;

    // Regex to find Telegram Links
    const urlRegex = /(https:\/\/t\.me\/[a-zA-Z0-9_]+\?start=[a-zA-Z0-9]+)/g;
    const matches = text.match(urlRegex);

    if (!matches) return ctx.answerCbQuery('⚠️ No links found.');

    // Replace links ONE BY ONE
    for (const longUrl of matches) {
        const shortUrl = await getShortLink(longUrl);
        if (shortUrl) {
            text = text.replace(longUrl, `${longUrl}\n✂️ <b>Short:</b> ${shortUrl}`);
        }
    }

    // Update Message
    try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
        ctx.reply('❌ Error updating message.');
    }
});

bot.action('admin_switch', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const cur = userModes[ctx.from.id] || 'batch'; // Default is Batch now
    const next = cur === 'single' ? 'batch' : 'single';
    userModes[ctx.from.id] = next;
    if (next === 'single') delete batchStorage[ctx.from.id];
    const count = batchStorage[ctx.from.id] ? batchStorage[ctx.from.id].length : 0;
    await ctx.editMessageText(`⚙️ <b>Admin Panel</b>\nMode: <b>${next.toUpperCase()}</b>\nQueue: ${count}`, { parse_mode: 'HTML', ...getAdminKeyboard(next, count) });
});

bot.action('admin_process', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const files = batchStorage[ctx.from.id];
    if (!files || !files.length) return ctx.answerCbQuery('⚠️ Empty Batch', { show_alert: true });
    
    await ctx.reply('⚙️ Processing...');
    const groups = {};
    files.forEach(f => {
        const k = getGroupId(f.raw_caption);
        if (!groups[k]) groups[k] = [];
        groups[k].push(f);
    });

    for (const k in groups) {
        let txt = "";
        groups[k].forEach(f => {
            const safeName = escapeHTML(cleanCaption(f.raw_caption));
            txt += `<b>${safeName}</b>\n${f.link}\n\n`;
        });
        // Send with "Shorten All" Button
        try { await ctx.reply(txt, { parse_mode: 'HTML', disable_web_page_preview: true, ...getBatchControls() }); } catch(e) {}
    }
    delete batchStorage[ctx.from.id];
    
    // Reset Panel
    const mode = userModes[ctx.from.id] || 'batch';
    await ctx.reply('✅ Done!', getAdminKeyboard(mode, 0));
});

bot.action('admin_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete batchStorage[ctx.from.id];
    const mode = userModes[ctx.from.id] || 'batch';
    await ctx.editMessageText(`⚙️ <b>Admin Panel</b>\nBatch Cleared!`, { parse_mode: 'HTML', ...getAdminKeyboard(mode, 0) });
});

bot.action(/checksub_(.+)/, async (ctx) => {
    const pl = ctx.match[1];
    if (await checkForceSub(ctx, ctx.from.id)) {
        await ctx.deleteMessage();
        if (pl !== 'checksub_home') {
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e){}
        } else await ctx.reply('👋 Welcome!');
    } else await ctx.answerCbQuery('⚠️ Join first!', { show_alert: true });
});

bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    try {
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const code = encodePayload(sent.message_id);
        const link = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        // DEFAULT MODE IS NOW BATCH
        const mode = userModes[ctx.from.id] || 'batch';
        
        let rawCap = ctx.message.caption || "";
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";

        if (mode === 'single') {
            const safeName = escapeHTML(cleanCaption(rawCap));
            await ctx.reply(`✅ <b>Saved!</b>\n\n<b>${safeName}</b>\n${link}`, { parse_mode: 'HTML', disable_web_page_preview: true, ...getFileControls(code) });
        } else {
            if (!batchStorage[ctx.from.id]) batchStorage[ctx.from.id] = [];
            batchStorage[ctx.from.id].push({ raw_caption: rawCap, link: link });
            await ctx.reply(`📥 Added (${batchStorage[ctx.from.id].length})`);
        }
    } catch (e) { await ctx.reply('❌ DB Channel Error.'); }
});

bot.start(async (ctx) => {
    const pl = ctx.payload;
    if (!await checkForceSub(ctx, ctx.from.id)) {
        return ctx.reply('⚠️ <b>Access Denied</b>', { parse_mode: 'HTML', ...await getJoinButtons(ctx, pl) });
    }
    
    if (pl) {
        const id = decodePayload(pl);
        if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File missing.'); }
        else ctx.reply('❌ Invalid Link.');
    } else {
        if (ctx.from.id === ADMIN_ID) {
            // DEFAULT TO BATCH
            const mode = userModes[ctx.from.id] || 'batch';
            await ctx.reply(`⚙️ <b>Admin Panel</b>`, { parse_mode: 'HTML', ...getAdminKeyboard(mode, 0) });
        } else {
            ctx.reply('🤖 Send me a link.');
        }
    }
});

// Text Handler for Config
bot.on('text', async (ctx) => {
    if (ctx.from.id === ADMIN_ID && awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text;
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            shortenerConfig = { domain, key };
            awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(`✅ <b>Configured:</b> ${domain}`, { parse_mode: 'HTML' });
            return ctx.reply(`⚙️ <b>Admin Panel</b>`, { parse_mode: 'HTML', ...getAdminKeyboard(userModes[ctx.from.id] || 'batch', 0) });
        }
        return ctx.reply('❌ Format: domain.com | api_key');
    }
});

export default async function handler(req, res) {
    try {
        if (req.method === 'POST') {
            if(!bot.botInfo) bot.botInfo = await bot.telegram.getMe();
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Active');
    } catch (e) { return res.status(500).send('Error'); }
}

