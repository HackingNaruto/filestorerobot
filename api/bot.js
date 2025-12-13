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
// Shortener Config (Priority: Memory > Env Var)
let shortenerConfig = {
    domain: process.env.SHORTENER_DOMAIN || "", 
    key: process.env.SHORTENER_KEY || ""
};
let awaitingShortenerConfig = {}; // To track if admin is typing config

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

// URL Shortener Function
const getShortLink = async (longUrl) => {
    if (!shortenerConfig.domain || !shortenerConfig.key) return null;
    try {
        const apiUrl = `https://${shortenerConfig.domain}/api?api=${shortenerConfig.key}&url=${encodeURIComponent(longUrl)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.status === 'success' || data.shortenedUrl) {
            return data.shortenedUrl;
        }
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
        [Markup.button.callback(`⚙️ Setup Shortener`, 'admin_shortener')], // New Button
        [Markup.button.callback(`📤 Process Batch (${count})`, 'admin_process')],
        [Markup.button.callback(`❌ Clear Batch`, 'admin_clear')]
    ]);
};

// Button for Single Files
const getFileControls = (shortCode) => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✂️ Shorten Link', `shorten_${shortCode}`)]
    ]);
};

// --- ADMIN ACTIONS ---

// 1. Setup Shortener (Instruction)
bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    awaitingShortenerConfig[ctx.from.id] = true;
    
    const current = shortenerConfig.domain ? `✅ Active: ${shortenerConfig.domain}` : "❌ Not Set";
    
    await ctx.reply(
        `⚙️ <b>Shortener Settings</b>\n\n` +
        `Current Status: ${current}\n\n` +
        `To setup, send details in this format:\n` +
        `<code>domain.com | api_key</code>\n\n` +
        `<i>Example: publicearn.com | 88474hdh...</i>\n\n` +
        `⚠️ <b>Note:</b> Since we use No-DB, this setting will reset if bot restarts. Add to Vercel Env Vars for permanent fix.`,
        { parse_mode: 'HTML' }
    );
});

// 2. Shorten Link Action (User clicks button)
bot.action(/shorten_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');
    
    const code = ctx.match[1]; // payload
    const botUsername = ctx.botInfo.username;
    const longLink = `https://t.me/${botUsername}?start=${code}`;
    
    // Check Config
    if (!shortenerConfig.domain || !shortenerConfig.key) {
        return ctx.answerCbQuery('⚠️ Shortener not configured! Go to Admin Panel.', { show_alert: true });
    }

    await ctx.answerCbQuery('⏳ Shortening...');

    const shortLink = await getShortLink(longLink);
    
    if (shortLink) {
        // Edit Message to append Short Link
        const originalText = ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption;
        // Need to reconstruct HTML msg carefully. 
        // Simple way: Append to existing text entities or just new text.
        // Since we can't easily get formatting from 'text', we regenerate based on logic if possible, 
        // OR just append plain text.
        
        // Let's try to keep Bold caption if possible
        const lines = ctx.callbackQuery.message.caption ? ctx.callbackQuery.message.caption.split('\n') : [];
        const captionLine = lines[0] || "File"; // Assuming first line is caption
        
        const newText = `<b>${escapeHTML(captionLine)}</b>\n\n🔗 <b>Original:</b> ${longLink}\n✂️ <b>Short:</b> ${shortLink}`;
        
        try {
            await ctx.editMessageText(newText, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
            // If it's a media caption, editMessageText won't work for caption directly simply.
            // Actually editMessageCaption is needed for media.
            if (ctx.callbackQuery.message.caption) {
                await ctx.editMessageCaption(newText, { parse_mode: 'HTML' });
            } else {
                await ctx.editMessageText(newText, { parse_mode: 'HTML', disable_web_page_preview: true });
            }
        }
    } else {
        await ctx.answerCbQuery('❌ Failed to shorten. Check API Key.', { show_alert: true });
    }
});

// Admin Panel Actions (Existing)
bot.action('admin_switch', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const cur = userModes[ctx.from.id] || 'single';
    const next = cur === 'single' ? 'batch' : 'single';
    userModes[ctx.from.id] = next;
    if (next === 'single') delete batchStorage[ctx.from.id];
    const count = batchStorage[ctx.from.id] ? batchStorage[ctx.from.id].length : 0;
    await ctx.editMessageText(
        `⚙️ <b>Admin Panel</b>\n\nCurrent Mode: <b>${next.toUpperCase()}</b>\nFiles in Queue: ${count}`,
        { parse_mode: 'HTML', ...getAdminKeyboard(next, count) }
    );
});

bot.action('admin_process', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const files = batchStorage[ctx.from.id];
    if (!files || !files.length) return ctx.answerCbQuery('⚠️ Batch is empty!', { show_alert: true });

    await ctx.reply('⚙️ Processing Automation...');
    const groups = {};
    files.forEach(f => {
        const groupKey = getGroupId(f.raw_caption);
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(f);
    });

    for (const k in groups) {
        let txt = "";
        groups[k].forEach(f => {
            const safeName = escapeHTML(cleanCaption(f.raw_caption));
            txt += `<b>${safeName}</b>\n${f.link}\n\n`;
        });
        try { await ctx.reply(txt, { parse_mode: 'HTML', disable_web_page_preview: true }); } 
        catch (e) { await ctx.reply('❌ Error sending group.'); }
    }
    delete batchStorage[ctx.from.id];
    await ctx.reply('✅ Automation Complete!', getAdminKeyboard(userModes[ctx.from.id], 0));
});

bot.action('admin_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete batchStorage[ctx.from.id];
    const mode = userModes[ctx.from.id] || 'single';
    await ctx.editMessageText(`⚙️ <b>Admin Panel</b>\n\nBatch Cleared!`, { parse_mode: 'HTML', ...getAdminKeyboard(mode, 0) });
});

// --- MAIN HANDLERS ---

// Handle Text (For Shortener Config)
bot.on('text', async (ctx, next) => {
    if (ctx.from.id === ADMIN_ID && awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text;
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            shortenerConfig = { domain, key };
            awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(`✅ <b>Shortener Configured!</b>\nDomain: ${domain}`, { parse_mode: 'HTML' });
            
            // Show Admin Panel again
            const mode = userModes[ctx.from.id] || 'single';
            return ctx.reply(`⚙️ <b>Admin Panel</b>`, { parse_mode: 'HTML', ...getAdminKeyboard(mode, 0) });
        } else {
            return ctx.reply('❌ Invalid Format. Use: `domain.com | api_key`');
        }
    }
    next();
});

// Admin Upload
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    try {
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const code = encodePayload(sent.message_id);
        const link = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        const mode = userModes[ctx.from.id] || 'single';
        
        let rawCap = ctx.message.caption;
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";

        if (mode === 'single') {
            const safeName = escapeHTML(cleanCaption(rawCap));
            // Show "Shorten Link" Button
            await ctx.reply(
                `✅ <b>Saved!</b>\n\n<b>${safeName}</b>\n${link}`, 
                { parse_mode: 'HTML', disable_web_page_preview: true, ...getFileControls(code) }
            );
        } else {
            if (!batchStorage[ctx.from.id]) batchStorage[ctx.from.id] = [];
            batchStorage[ctx.from.id].push({ raw_caption: rawCap, link: link });
            const count = batchStorage[ctx.from.id].length;
            await ctx.reply(`📥 Added to Batch (${count})`);
        }
    } catch (e) { await ctx.reply('❌ Error: Bot not admin in DB Channel.'); }
});

// Force Sub Check & Start
const checkForceSubControls = async (ctx, payload) => {
    const buttons = [];
    for (const id of FORCE_SUB_IDS) {
        try {
            const chat = await ctx.telegram.getChat(id);
            const link = chat.invite_link || `https://t.me/${chat.username.replace('@','')}`;
            buttons.push([Markup.button.url(`Join ${chat.title}`, link)]);
        } catch (e) {}
    }
    const cb = payload ? `checksub_${payload}` : 'checksub_home';
    buttons.push([Markup.button.callback('🔄 Try Again / Verified', cb)]);
    return Markup.inlineKeyboard(buttons);
};

bot.action(/checksub_(.+)/, async (ctx) => {
    const pl = ctx.match[1];
    if (await checkForceSub(ctx, ctx.from.id)) {
        await ctx.deleteMessage();
        if (pl !== 'checksub_home') {
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e){}
        } else await ctx.reply('👋 Welcome!');
    } else await ctx.answerCbQuery('⚠️ Join channels first!', { show_alert: true });
});

bot.start(async (ctx) => {
    const pl = ctx.payload;
    if (!await checkForceSub(ctx, ctx.from.id)) {
        return ctx.reply('⚠️ <b>Access Denied</b>\n\nPlease join our channels.', { parse_mode: 'HTML', ...await checkForceSubControls(ctx, pl) });
    }
    if (pl) {
        const id = decodePayload(pl);
        if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File gone.'); }
        else ctx.reply('❌ Invalid Link.');
    } else {
        if (ctx.from.id === ADMIN_ID) {
            const mode = userModes[ctx.from.id] || 'single';
            const count = batchStorage[ctx.from.id] ? batchStorage[ctx.from.id].length : 0;
            await ctx.reply(`⚙️ <b>Admin Panel</b>`, { parse_mode: 'HTML', ...getAdminKeyboard(mode, count) });
        } else {
            ctx.reply('🤖 Send me a link to get files.');
        }
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
