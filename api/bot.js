const { Telegraf, Markup } = require('telegraf');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "").split(',').map(id => id.trim()).filter(id => id);

// --- MEMORY STORAGE ---
global.batchStorage = global.batchStorage || {}; // Stores files temporarily
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
        [Markup.button.callback(`📤 Process Batch Now`, 'batch_process')],
        [Markup.button.callback(`❌ Clear Queue`, 'batch_clear')]
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
    await ctx.reply("🗑 Queue Cleared!");
});

// --- 🔥 BATCH PROCESSOR (The Fix for 7 Messages) 🔥 ---
bot.action('batch_process', async (ctx) => {
    await processBatch(ctx);
});
bot.command('batch', async (ctx) => {
    await processBatch(ctx);
});

async function processBatch(ctx) {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    
    const files = global.batchStorage[ctx.from.id];
    if (!files || files.length === 0) return ctx.reply('⚠️ Queue is empty! Send files first.');

    await ctx.reply(`⏳ Processing ${files.length} files...`);

    let finalMessage = "";

    // Loop through all stored files
    for (const file of files) {
        let shortLink = null;
        
        // Try to shorten
        if (global.shortenerConfig.domain && global.shortenerConfig.key) {
            shortLink = await getShortLink(file.longLink);
        }

        // FORMAT: 
        // Caption
        // Original Link
        // Short Link
        finalMessage += `${file.caption}\nOriginal: ${file.longLink}\n`;
        
        if (shortLink) {
            finalMessage += `Short: ${shortLink}\n\n`;
        } else {
            finalMessage += `(Shortener Failed)\n\n`;
        }
    }

    // Send the Big Message
    try {
        await ctx.reply(finalMessage, { disable_web_page_preview: true });
        // Clear queue after success
        delete global.batchStorage[ctx.from.id];
    } catch (e) {
        ctx.reply(`❌ Error sending message (Too long?): ${e.message}`);
    }
}

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

// --- ADMIN UPLOAD (COLLECT FILES) ---
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (!ctx.from) return; 
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    
    try {
        // 1. Copy to Channel
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        
        // 2. Generate Long Link
        const code = encodePayload(sent.message_id);
        const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        
        // 3. Get Clean Caption
        let rawCap = ctx.message.caption || "";
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";
        const safeName = cleanCaption(rawCap);

        // 4. ADD TO QUEUE (Don't reply yet!)
        if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = [];
        
        global.batchStorage[ctx.from.id].push({
            caption: safeName,
            longLink: longLink
        });

        // 5. Silent Confirmation (Optional: Delete to keep chat clean, or just ignore)
        // Just sending a "dot" or updating a counter could be better, but for now:
        const count = global.batchStorage[ctx.from.id].length;
        if (count === 1) {
            await ctx.reply(`📥 Started Batch. Send more files.\nWhen finished, click 'Process Batch' or type /batch`, getAdminKeyboard());
        }

    } catch (e) { 
        console.error(e);
        ctx.reply('❌ DB Channel Error.');
    }
});

// --- START COMMAND (FIXED) ---
bot.start(async (ctx) => {
    try {
        // 1. Check Payload (User asking for file)
        const pl = ctx.payload;
        if (pl) {
            if (!await checkForceSub(ctx, ctx.from.id)) {
                return ctx.reply('⚠️ Access Denied', { ...await getJoinButtons(ctx, pl) });
            }
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File missing.'); }
            else ctx.reply('❌ Invalid Link.');
            return;
        }

        // 2. No Payload - Check if Admin
        if (ctx.from.id === ADMIN_ID) {
            const count = global.batchStorage[ctx.from.id] ? global.batchStorage[ctx.from.id].length : 0;
            await ctx.reply(`👋 <b>Hello Admin!</b>\n\nFiles in Queue: ${count}\n\nSend files to start batching.`, { parse_mode: 'HTML', ...getAdminKeyboard() });
        } else {
            // 3. Normal User
            if (!await checkForceSub(ctx, ctx.from.id)) {
                return ctx.reply('⚠️ Access Denied', { ...await getJoinButtons(ctx, '') });
            }
            ctx.reply('🤖 Send me a link to get files.');
        }

    } catch (e) {
        ctx.reply(`Start Error: ${e.message}`);
    }
});

bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    // Shortener Config Logic
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
