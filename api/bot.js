const { Telegraf, Markup } = require('telegraf');
const FormData = require('form-data');

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

// 2. Upload to Catbox (FIXED WITH HEADERS)
const uploadToCatbox = async (fileUrl) => {
    try {
        // Fetch Image
        const fileRes = await fetch(fileUrl);
        const buffer = await fileRes.arrayBuffer();
        
        // Create Form Data
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', Buffer.from(buffer), { filename: 'image.jpg', contentType: 'image/jpeg' });

        // Upload with Headers (Important for Node.js)
        const response = await fetch('https://catbox.moe/user/api.php', {
            method: 'POST',
            body: form,
            headers: form.getHeaders() // <--- THIS WAS MISSING
        });
        
        const text = await response.text();
        if (text.startsWith('http')) return text.trim();
        return null;
    } catch (e) {
        console.error("Catbox Error:", e);
        return null;
    }
};

// 3. Create Telegraph Page
const createTelegraphPage = async (title, nodes) => {
    try {
        if (!global.telegraphToken) {
            const accRes = await fetch(`https://api.telegra.ph/createAccount?short_name=FileBot&author_name=Admin`);
            const accData = await accRes.json();
            if (accData.ok) global.telegraphToken = accData.result.access_token;
        }

        const contentStr = JSON.stringify(nodes);
        const response = await fetch('https://api.telegra.ph/createPage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                access_token: global.telegraphToken,
                title: title,
                content: contentStr,
                return_content: true
            })
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
        [Markup.button.callback(`📝 Create Graph.org Page`, 'batch_create_graph')],
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

// --- CREATE GRAPH PAGE ---
bot.action('batch_create_graph', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Admin only');

    const userData = global.batchStorage[ctx.from.id];
    if (!userData || (!userData.files.length && !userData.poster)) {
        return ctx.reply('⚠️ Queue empty. Send files and an image (optional).');
    }

    if (!global.shortenerConfig.domain || !global.shortenerConfig.key) {
        return ctx.reply('⚠️ Shortener not configured!');
    }

    await ctx.reply("⏳ Processing... Creating Page...");

    let domNodes = [];

    // Add Poster
    if (userData.poster) {
        domNodes.push({ tag: 'img', attrs: { src: userData.poster } });
        domNodes.push({ tag: 'br' });
    }

    // Add Header
    domNodes.push({ tag: 'h4', children: ['📂 Download Files'] });
    domNodes.push({ tag: 'hr' });

    // Process Files
    for (const file of userData.files) {
        const shortLink = await getShortLink(file.longLink) || file.longLink;
        
        domNodes.push({ 
            tag: 'p', 
            children: [
                { tag: 'b', children: [file.caption] },
                { tag: 'br' },
                { tag: 'a', attrs: { href: shortLink }, children: ['📥 Download Here'] }
            ]
        });
        domNodes.push({ tag: 'br' });
    }

    domNodes.push({ tag: 'hr' });
    domNodes.push({ tag: 'i', children: ['Join our Channel'] });

    const pageTitle = userData.files[0] ? userData.files[0].caption : "File Collection";
    const graphUrl = await createTelegraphPage(pageTitle, domNodes);

    if (graphUrl) {
        await ctx.reply(`✅ **Graph Page Created!**\n\n🔗 ${graphUrl}`, { disable_web_page_preview: false });
        delete global.batchStorage[ctx.from.id];
    } else {
        await ctx.reply("❌ Failed to create Graph page.");
    }
});

// --- UPLOAD HANDLERS ---

// 1. Handle POSTER
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
            
            await ctx.reply(`✅ **Poster Set!**\n\nNow send files.`, getAdminKeyboard());
        } else {
            await ctx.reply("❌ Catbox Upload Failed. Check Logs.");
        }
    } catch (e) {
        console.error(e);
        ctx.reply("❌ Error processing image.");
    }
});

// 2. Handle FILES
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
        
        global.batchStorage[ctx.from.id].files.push({
            caption: safeName,
            longLink: longLink
        });

        const count = global.batchStorage[ctx.from.id].files.length;
        if (count === 1) {
            await ctx.reply(`📥 **Batch Started.**\n\nSend Image -> Send Files -> Click 'Create Graph'`, getAdminKeyboard());
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
