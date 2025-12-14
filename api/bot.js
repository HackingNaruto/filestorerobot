const { Telegraf, Markup } = require('telegraf');

// --- CONFIGURATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_ID = Number(process.env.ADMIN_ID);
const FORCE_SUB_IDS = (process.env.FORCE_SUB_CHANNELS || "").split(',').map(id => id.trim()).filter(id => id);

// --- MEMORY STORAGE ---
global.batchStorage = global.batchStorage || {}; 
global.shortenerConfig = global.shortenerConfig || {
    domain: process.env.SHORTENER_DOMAIN || "", 
    key: process.env.SHORTENER_KEY || ""
};
global.telegraphToken = global.telegraphToken || ""; 

// --- ERROR HANDLING ---
bot.catch((err, ctx) => {
    console.error(`Bot Error:`, err);
    try { ctx.reply(`⚠️ Error: ${err.message}`); } catch(e) {}
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

const extractTitle = (text) => {
    const match = text.match(/^(.+?\(\d{4}\))/);
    if (match) return match[1].trim(); 
    return text.split('-')[0].trim(); 
};

// --- API FUNCTIONS ---

// 1. URL Shortener
const getShortLink = async (longUrl) => {
    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) return null;
    try {
        const apiUrl = `https://${global.shortenerConfig.domain}/api?api=${global.shortenerConfig.key}&url=${encodeURIComponent(longUrl)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.status === 'success' || data.shortenedUrl) return data.shortenedUrl;
        return null;
    } catch (error) { return null; }
};

// 2. Upload to Catbox
const uploadToCatbox = async (fileUrl) => {
    try {
        const fileRes = await fetch(fileUrl);
        const blob = await fileRes.blob();
        const formData = new FormData();
        formData.append('reqtype', 'fileupload');
        formData.append('fileToUpload', blob, 'image.jpg');

        const response = await fetch('https://catbox.moe/user/api.php', {
            method: 'POST',
            body: formData
        });
        
        const text = await response.text();
        if (text.startsWith('http')) return text.trim();
        return null;
    } catch (e) { return null; }
};

// 3. Create Telegraph Page
const createTelegraphPage = async (title, nodes) => {
    try {
        if (!global.telegraphToken) {
            const accRes = await fetch(`https://api.telegra.ph/createAccount?short_name=StarFlix&author_name=@StarFlixTamil`);
            const accData = await accRes.json();
            if (accData.ok) global.telegraphToken = accData.result.access_token;
        }

        const contentStr = JSON.stringify(nodes);
        const params = new URLSearchParams();
        params.append('access_token', global.telegraphToken);
        params.append('title', title);
        params.append('author_name', '@StarFlixTamil');
        params.append('author_url', 'https://t.me/StarFlixTamil');
        params.append('content', contentStr);
        params.append('return_content', 'true');

        const response = await fetch('https://api.telegra.ph/createPage', {
            method: 'POST',
            body: params
        });
        
        const data = await response.json();
        if (data.ok) return data.result.url;
        return null;
    } catch (e) {
        console.error("Telegraph Error:", e);
        return null;
    }
};

// --- KEYBOARDS ---
const getAdminKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`⚙️ Setup Shortener`, 'admin_shortener')],
        [Markup.button.callback(`📝 Create Graph Page`, 'batch_create_graph')],
        [Markup.button.callback(`❌ Clear Queue`, 'batch_clear')]
    ]);
};

// --- HANDLERS ---

bot.action('batch_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete global.batchStorage[ctx.from.id];
    await ctx.reply("🗑 Queue Cleared!", getAdminKeyboard());
});

bot.action('admin_shortener', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.awaitingShortenerConfig[ctx.from.id] = true;
    await ctx.reply(`⚙️ Send Shortener Config:\ndomain.com | api_key`);
});

// --- 🔥 CREATE GRAPH PAGE (ALL BOLD FIXED) 🔥 ---
bot.action('batch_create_graph', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');

    const userData = global.batchStorage[ctx.from.id];
    if (!userData || (!userData.files.length && !userData.poster)) {
        return ctx.reply('⚠️ Queue empty. Send files and an image.');
    }

    await ctx.reply("⏳ Creating Page...");

    let domNodes = [];

    // 1. Title Extraction
    const firstFileCaption = userData.files[0] ? userData.files[0].caption : "Movie Collection";
    const cleanTitle = extractTitle(firstFileCaption);

    // 2. Poster Image with Caption
    if (userData.poster) {
        domNodes.push({
            tag: 'figure',
            children: [
                { tag: 'img', attrs: { src: userData.poster } },
                { tag: 'figcaption', children: [cleanTitle] }
            ]
        });
    }

    // 3. "Telegram Files" Header (BOLD)
    domNodes.push({ 
        tag: 'p', 
        children: [{ tag: 'b', children: ['Telegram Files'] }] 
    });
    domNodes.push({ tag: 'br' });

    // 4. File List (ALL BOLD: Name & Link)
    for (const file of userData.files) {
        const shortLink = await getShortLink(file.longLink) || file.longLink;
        
        domNodes.push({
            tag: 'p',
            children: [
                // File Name (Bold)
                { tag: 'b', children: [file.caption] },
                { tag: 'br' },
                // Link (Bold + Clickable)
                { 
                    tag: 'b', 
                    children: [{ tag: 'a', attrs: { href: shortLink }, children: [shortLink] }] 
                }
            ]
        });
        domNodes.push({ tag: 'br' });
    }

    // 5. Footer (BOLD)
    domNodes.push({ tag: 'br' });
    domNodes.push({ 
        tag: 'p', 
        children: [{ tag: 'b', children: ['⭕️ Main Channel : @StarFlixTamil ⭕️'] }] 
    });

    // Create Page
    let graphUrl = await createTelegraphPage(cleanTitle, domNodes);

    if (graphUrl) {
        graphUrl = graphUrl.replace('telegra.ph', 'graph.org');
        await ctx.reply(`✅ **Graph Page Ready!**\n\n🔗 ${graphUrl}`, { disable_web_page_preview: false });
        delete global.batchStorage[ctx.from.id];
    } else {
        await ctx.reply("❌ Failed to create Graph page.");
    }
});

// --- UPLOAD HANDLERS (ADDED FEEDBACK) ---

bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.reply("🖼 Uploading to Catbox...");
    try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const catboxUrl = await uploadToCatbox(fileLink.href);

        if (catboxUrl) {
            if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = { files: [], poster: null };
            global.batchStorage[ctx.from.id].poster = catboxUrl;
            await ctx.reply(`✅ **Poster Set!**\nNow send files.`, getAdminKeyboard());
        } else {
            await ctx.reply("❌ Upload Failed.");
        }
    } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
});

bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (!ctx.from) return; 
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    try {
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const code = encodePayload(sent.message_id);
        const longLink = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        
        let rawCap = ctx.message.caption || "";
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";
        const safeName = cleanCaption(rawCap);

        if (!global.batchStorage[ctx.from.id]) global.batchStorage[ctx.from.id] = { files: [], poster: null };
        global.batchStorage[ctx.from.id].files.push({ caption: safeName, longLink: longLink });

        // --- 🔥 Feedback Added Here 🔥 ---
        const count = global.batchStorage[ctx.from.id].files.length;
        await ctx.reply(`📂 Added (${count})`);
        
        if (count === 1) {
            await ctx.reply(`ℹ️ **Batch Started.**\nSend all files, then click 'Create Graph'`, getAdminKeyboard());
        }

    } catch (e) { ctx.reply('❌ DB Channel Error.'); }
});

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

bot.start(async (ctx) => {
    try {
        const pl = ctx.payload;
        if (pl) {
            if (!await checkForceSub(ctx, ctx.from.id)) return ctx.reply('⚠️ Access Denied', { ...await getJoinButtons(ctx, pl) });
            const id = decodePayload(pl);
            if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File missing.'); }
            else ctx.reply('❌ Invalid Link.');
            return;
        }
        if (ctx.from.id === ADMIN_ID) {
            const userData = global.batchStorage[ctx.from.id];
            const count = userData ? userData.files.length : 0;
            const hasPoster = userData && userData.poster ? "✅ Set" : "❌ Not Set";
            await ctx.reply(`👋 <b>Admin Panel</b>\nFiles: ${count}\nPoster: ${hasPoster}`, { parse_mode: 'HTML', ...getAdminKeyboard() });
        } else {
            ctx.reply('🤖 Send me a link.');
        }
    } catch (e) {}
});

bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    if (ctx.from.id === ADMIN_ID && global.awaitingShortenerConfig[ctx.from.id]) {
        const text = ctx.message.text;
        if (text.includes('|')) {
            const [domain, key] = text.split('|').map(s => s.trim());
            global.shortenerConfig = { domain, key };
            global.awaitingShortenerConfig[ctx.from.id] = false;
            await ctx.reply(`✅ Configured: ${domain}`, getAdminKeyboard());
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
        return res.status(200).send('Bot Active 🚀');
    } catch (e) {
        console.error(e);
        return res.status(500).send('Error');
    }
}

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
