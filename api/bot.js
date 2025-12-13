const { Telegraf, Markup } = require('telegraf');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "").split(',').map(id => id.trim()).filter(id => id);

// --- MEMORY STORAGE (Global Variables) ---
// Note: In Vercel, these might reset after some time of inactivity.
global.userModes = global.userModes || {};     
global.batchStorage = global.batchStorage || {};
global.shortenerConfig = global.shortenerConfig || {
    domain: process.env.SHORTENER_DOMAIN || "", 
    key: process.env.SHORTENER_KEY || ""
};
global.awaitingShortenerConfig = global.awaitingShortenerConfig || {}; 

// --- ERROR HANDLING (Prevents Bot from going Silent) ---
bot.catch((err, ctx) => {
    console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
    // Try to tell the user something went wrong
    try {
        ctx.reply("❌ Error occurred! Check Vercel Logs.");
    } catch (e) {}
});

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

// CRITICAL FIX: Escapes HTML symbols to prevent crash
const escapeHTML = (text) => {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
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
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return null;
    try {
        // Using built-in fetch (Node 18+)
        const apiUrl = `https://${global.shortenerConfig.domain}/api?api=${global.shortenerConfig.key}&url=${encodeURIComponent(longUrl)}`;
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

const getFileControls = (shortCode) => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✂️ Shorten Link', `shorten_${shortCode}`)]
    ]);
};

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

// --- ADMIN ACTIONS ---

bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.awaitingShortenerConfig[ctx.from.id] = true;
    const current = global.shortenerConfig.domain ? `✅ Active: ${global.shortenerConfig.domain}` : "❌ Not Set";
    await ctx.reply(`⚙️ <b>Shortener Config</b>\nStatus: ${current}\n\nSend: <code>domain.com | api_key</code>`, { parse_mode: 'HTML' });
});

bot.action(/shorten_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');
    const code = ctx.match[1];
    const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
    
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return ctx.answerCbQuery('⚠️ Configure Shortener first!', { show_alert: true });
    
    await ctx.answerCbQuery('⏳ Shortening...');
    const shortLink = await getShortLink(longLink);
    
    if (shortLink) {
        let newText = ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption || "";
        newText += `\n\n🔗 <b>Original:</b> ${longLink}\n✂️ <b>Short:</b> ${shortLink}`;
        
        try {
            if (ctx.callbackQuery.message.caption) await ctx.editMessageCaption(newText, { parse_mode: 'HTML' });
            else await ctx.editMessageText(newText, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch(e) { console.error(e); }
    } else {
        await ctx.answerCbQuery('❌ API Error.', { show_alert: true });
    }
});

bot.action('batch_shorten_all', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return ctx.answerCbQuery('⚠️ Setup Shortener first!', { show_alert: true });

    await ctx.answerCbQuery('⏳ Processing all links...');
    
    let text = ctx.callbackQuery.message.text;
    if (!text) return;

    const urlRegex = /(https:\/\/t\.me\/[a-zA-Z0-9_]+\?start=[a-zA-Z0-9]+)/g;
    const matches = text.match(urlRegex);

    if (!matches) return ctx.answerCbQuery('⚠️ No links found.');

    for (const longUrl of matches) {
        // Skip if already shortened (check if next line is 'Short:')
        if (text.includes(longUrl + "\n✂️")) continue;

        const shortUrl = await getShortLink(longUrl);
        if (shortUrl) {
            text = text.replace(longUrl, `${longUrl}\n✂️ <b>Short:</b> ${shortUrl}`);
        }
    }

    try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) { ctx.reply('❌ Error updating message.'); }
});


bot.action('admin_switch', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const cur = global.userModes[ctx.from.id] || 'batch';
    const next = cur === 'single' ? 'batch' : 'single';
    global.userModes[ctx.from.id] = next;
    if (next === 'single') delete global.batchStorage[ctx.from.id];
    const count = global.batchStorage[ctx.from.id] ? global.batchStorage[ctx.from.id].length : 0;
    await ctx.editMessageText(`⚙️ <b>Admin Panel</b>\nMode: <b>${next.toUpperCase()}</b>\nQueue: ${count}`, { parse_mode: 'HTML', ...getAdminKeyboard(next, count) });
});

bot.action('admin_process', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const files = global.batchStorage[ctx.from.id];
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
        try { await ctx.reply(txt, { parse_mode: 'HTML', disable_web_page_preview: true, ...getBatchControls() }); } catch(e) {
            ctx.reply(`❌ HTML Error in group: ${k}. Check filenames for special symbols.`);
        }
    }
    delete global.batchStorage[ctx.from.id];
    await ctx.reply('✅ Done!', getAdminKeyboard(global.userModes[ctx.from.id], 0));
});

bot.action('admin_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete global.batchStorage[ctx.from.id];
    const mode = global.userModes[ctx.from.id] || 'batch';
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

// --- ADMIN UPLOAD ---
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    try {
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const code = encodePayload(sent.message_id);
        const link = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        const mode = global.userModes[ctx.from.id] || 'batch';
        
        let rawCap = ctx.message.caption || "";
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";

        if (mode === 'single') {
            const safeName = escapeHTML(cleanCaption(rawCap));
            await ctx.reply(`✅ <b>Saved!</b>\n\n<b>${safeName}</b>\n${link}`, { parse_mode: 'HTML', disable_web_page_preview: true, ...getFileControls(code) });
        } else {
            if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = [];
            global.batchStorage[ctx.from.id].push({ raw_caption: rawCap, link: link });
            await ctx.reply(`📥 Added (${global.batchStorage[ctx.from.id].length})`);
        }
    } catch (e) { 
        console.error(e);
        await ctx.reply('❌ DB Channel Error: Check Channel ID & Admin Rights.'); 
    }
});

// --- START & TEXT ---
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
            const mode = global.userModes[ctx.from.id] || 'batch';
            await ctx.reply(`⚙️ <b>Admin Panel</b>`, { parse_mode: 'HTML', ...getAdminKeyboard(mode, 0) });
        } else {
            ctx.reply('🤖 Send me a link.');
        }
    }
});

bot.on('text', async (ctx) => {
    if (ctx.from.id === ADMIN_ID && global.awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text;
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            global.shortenerConfig = { domain, key };
            global.awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(`✅ <b>Configured:</b> ${domain}`, { parse_mode: 'HTML' });
            return ctx.reply(`⚙️ <b>Admin Panel</b>`, { parse_mode: 'HTML', ...getAdminKeyboard(global.userModes[ctx.from.id] || 'batch', 0) });
        }
        return ctx.reply('❌ Format: domain.com | api_key');
    }
});

// --- VERCEL HANDLER (Strict) ---
export default async function handler(req, res) {
    try {
        if (req.method === 'POST') {
            // Ensure bot info is loaded (Critical for Vercel)
            if(!bot.botInfo) bot.botInfo = await bot.telegram.getMe();
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot Active 🚀');
    } catch (e) {
        console.error("Handler Error:", e);
        return res.status(500).send('Error: ' + e.message);
    }
}
