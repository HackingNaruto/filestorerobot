const { Telegraf, Markup } = require('telegraf');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "").split(',').map(id => id.trim()).filter(id => id);

// --- MEMORY STORAGE ---
global.batchStorage = global.batchStorage || {}; // Stores files
global.shortenerConfig = global.shortenerConfig || {
    domain: process.env.SHORTENER_DOMAIN || "", 
    key: process.env.SHORTENER_KEY || ""
};
global.awaitingShortenerConfig = global.awaitingShortenerConfig || {}; 

// --- ERROR HANDLING ---
bot.catch((err, ctx) => {
    console.error(`Error`, err);
});

// --- HELPERS ---
const encodePayload = (msgId) => {
    const text = `File_${msgId}_Secure`; 
    return Buffer.from(text).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); 
};

const decodePayload = (code) => {
    try {
        let base64 = code.replace(/-/g, '+').replace(/_/g, '/');
        const text = Buffer.from(base64, 'base64').toString('utf-8');
        const parts = text.split('_');
        if (parts[0] === 'File' && parts[2] === 'Secure') return parseInt(parts[1]);
        return null;
    } catch (e) { return null; }
};

const cleanCaption = (text) => {
    if (!text) return "Untitled File";
    let clean = String(text)
        .replace(/⭕️ Main Channel : @StarFlixTamil ⭕️/g, "")
        .replace(/(Main Channel|Join Channel).*/gi, "")
        .replace(/@[\w_]+/g, "");
    return clean.trim();
};

const getShortLink = async (longUrl) => {
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return null;
    try {
        const apiUrl = `https://${global.shortenerConfig.domain}/api?api=${global.shortenerConfig.key}&url=${encodeURIComponent(longUrl)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.status === 'success' || data.shortenedUrl) return data.shortenedUrl;
        return null;
    } catch (error) {
        return null; 
    }
};

// --- KEYBOARDS ---
const getAdminKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`⚙️ Setup Shortener`, 'admin_shortener')],
        [Markup.button.callback(`📤 Process Queue`, 'batch_show_original')],
        [Markup.button.callback(`❌ Clear Queue`, 'batch_clear')]
    ]);
};

// Button to trigger Shortening
const getShortenButton = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✂️ Shorten Now', 'transform_to_short')]
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

const checkForceSub = async (ctx, userId) => {
    if (!userId) return true;
    if (userId === ADMIN_ID) return true;
    if (FORCE_SUB_IDS.length === 0) return true;
    for (const channelId of FORCE_SUB_IDS) {
        try {
            const member = await ctx.telegram.getChatMember(channelId, userId);
            if (['left', 'kicked', 'restricted'].includes(member.status)) return false;
        } catch (err) {}
    }
    return true;
};

// --- ADMIN ACTIONS ---
bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.awaitingShortenerConfig[ctx.from.id] = true;
    const current = global.shortenerConfig.domain ? `✅ Active: ${global.shortenerConfig.domain}` : "❌ Not Set";
    await ctx.reply(`⚙️ Shortener Config\nStatus: ${current}\n\nSend: domain.com | api_key`);
});

bot.action('batch_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete global.batchStorage[ctx.from.id];
    await ctx.reply("🗑 Queue Cleared!", getAdminKeyboard());
});

// --- STEP 1: SHOW ORIGINAL LINKS ---
bot.action('batch_show_original', async (ctx) => {
    await showOriginalBatch(ctx);
});
bot.command('batch', async (ctx) => {
    await showOriginalBatch(ctx);
});

async function showOriginalBatch(ctx) {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    
    const files = global.batchStorage[ctx.from.id];
    if (!files || files.length === 0) return ctx.reply('⚠️ Queue is empty! Send files first.');

    await ctx.reply(`⏳ Generating Original Links...`);

    let finalMessage = "";
    for (const file of files) {
        // Output: Caption + Original Link
        finalMessage += `${file.caption}\n${file.longLink}\n\n`;
    }

    try {
        // Send message with "Shorten Now" button
        await ctx.reply(finalMessage, { 
            disable_web_page_preview: true,
            ...getShortenButton() 
        });
        
        // Clear queue after showing original links? 
        // Better to keep it until they shorten, but for simplicity let's clear it 
        // because the message is already sent.
        delete global.batchStorage[ctx.from.id];

    } catch (e) {
        ctx.reply(`❌ Error (Message too long?): ${e.message}`);
    }
}

// --- STEP 2: CLICK BUTTON -> CONVERT TO SHORT LINKS ---
bot.action('transform_to_short', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');
    
    // Check Config
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) {
        return ctx.answerCbQuery('⚠️ Setup Shortener first!', { show_alert: true });
    }

    await ctx.answerCbQuery('⏳ Shortening links...');

    const originalText = ctx.callbackQuery.message.text;
    if (!originalText) return;

    // 1. Find all Telegram Links
    const matches = [...originalText.matchAll(/https:\/\/t\.me\/[^\s]+/g)];
    if (matches.length === 0) return ctx.answerCbQuery('No links found');

    // 2. Get unique URLs (to save API calls)
    const uniqueUrls = [...new Set(matches.map(m => m[0]))];
    const shortLinksMap = {};

    // 3. Parallel Shortening
    await Promise.all(uniqueUrls.map(async (longUrl) => {
        const short = await getShortLink(longUrl);
        if (short) shortLinksMap[longUrl] = short;
    }));

    // 4. Replace Links in Text
    let newText = originalText;
    for (const longUrl of uniqueUrls) {
        if (shortLinksMap[longUrl]) {
            // Global replace of this URL
            newText = newText.split(longUrl).join(shortLinksMap[longUrl]);
        }
    }

    // 5. Edit the Message
    try {
        await ctx.editMessageText(newText, { disable_web_page_preview: true });
    } catch (e) {
        ctx.reply(`❌ Update Error: ${e.message}`);
    }
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

// --- ADMIN UPLOAD (COLLECT ONLY) ---
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (!ctx.from) return; 
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    
    try {
        // 1. Copy to Channel
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        
        // 2. Generate Long Link
        const code = encodePayload(sent.message_id);
        const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        
        // 3. Clean Caption
        let rawCap = ctx.message.caption || "";
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";
        const safeName = cleanCaption(rawCap);

        // 4. ADD TO QUEUE
        if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = [];
        
        global.batchStorage[ctx.from.id].push({
            caption: safeName,
            longLink: longLink
        });

        // 5. Feedback (Optional - prevents spamming)
        const count = global.batchStorage[ctx.from.id].length;
        if (count === 1) {
            await ctx.reply(`📥 Queue Started.\n\nSend all files, then click "Process Queue".`, getAdminKeyboard());
        }

    } catch (e) { 
        ctx.reply('❌ DB Channel Error.');
    }
});

// --- START & TEXT ---
bot.start(async (ctx) => {
    try {
        const pl = ctx.payload;
        // User requesting file
        if (pl) {
            if (!await checkForceSub(ctx, ctx.from.id)) {
                return ctx.reply('⚠️ Access Denied', { ...await getJoinButtons(ctx, pl) });
            }
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File missing.'); }
            else ctx.reply('❌ Invalid Link.');
            return;
        }

        // Admin Panel
        if (ctx.from.id === ADMIN_ID) {
            const count = global.batchStorage[ctx.from.id] ? global.batchStorage[ctx.from.id].length : 0;
            await ctx.reply(`👋 <b>Admin Panel</b>\nFiles in Queue: ${count}`, { parse_mode: 'HTML', ...getAdminKeyboard() });
        } else {
            if (!await checkForceSub(ctx, ctx.from.id)) {
                return ctx.reply('⚠️ Access Denied', { ...await getJoinButtons(ctx, '') });
            }
            ctx.reply('🤖 Send me a link.');
        }

    } catch (e) {
        ctx.reply(`Start Error: ${e.message}`);
    }
});

bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    if (ctx.from.id === ADMIN_ID && global.awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text;
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            global.shortenerConfig = { domain, key };
            global.awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(`✅ Configured: ${domain}`);
            return ctx.reply(`⚙️ Admin Panel`, getAdminKeyboard());
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
        return res.status(200).send('Bot Active 🚀');
    } catch (e) {
        console.error(e);
        return res.status(500).send('Error');
    }
}
