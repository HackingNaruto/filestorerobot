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

// Caption Cleaner: Removes "Main Channel..." and other unwanted lines
const cleanCaption = (text) => {
    if (!text) return "Untitled File";
    
    return text
        .replace(/⭕️ Main Channel : @StarFlixTamil ⭕️/g, "") // Remove specific tag
        .replace(/@[\w_]+/g, "") // Remove any other @username
        .replace(/(Main Channel|Join Channel).*/gi, "") // Remove lines starting with Main Channel
        .trim(); // Remove extra spaces
};

// Grouping Logic (First 2 words)
const getGroupId = (text) => {
    const cleaned = cleanCaption(text);
    const words = cleaned.split(' ').filter(w => w.trim() !== ""); // Filter empty spaces
    if (words.length >= 2) return `${words[0]} ${words[1]}`.toLowerCase();
    return words[0] ? words[0].toLowerCase() : "unknown";
};

const checkForceSub = async (ctx, userId) => {
    if (userId === ADMIN_ID || FORCE_SUB_IDS.length === 0) return true;
    for (const channelId of FORCE_SUB_IDS) {
        try {
            const member = await ctx.telegram.getChatMember(channelId, userId);
            if (['left', 'kicked', 'restricted'].includes(member.status)) return false;
        } catch (e) { return false; }
    }
    return true;
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
    buttons.push([Markup.button.callback('🔄 Try Again / Verified', cb)]);
    return Markup.inlineKeyboard(buttons);
};

// --- ADMIN PANEL BUTTONS ---
const getAdminKeyboard = (mode, count) => {
    const modeIcon = mode === 'batch' ? '🟢 Batch On' : '🔴 Batch Off (Single)';
    return Markup.inlineKeyboard([
        [Markup.button.callback(`🔄 Switch Mode (${mode.toUpperCase()})`, 'admin_switch')],
        [Markup.button.callback(`📤 Process Batch (${count})`, 'admin_process')],
        [Markup.button.callback(`❌ Clear Batch`, 'admin_clear')]
    ]);
};

// --- ADMIN ACTIONS ---

// 1. Switch Mode Action
bot.action('admin_switch', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const cur = userModes[ctx.from.id] || 'single';
    const next = cur === 'single' ? 'batch' : 'single';
    userModes[ctx.from.id] = next;
    
    if (next === 'single') delete batchStorage[ctx.from.id];
    
    const count = batchStorage[ctx.from.id] ? batchStorage[ctx.from.id].length : 0;
    
    await ctx.editMessageText(
        `⚙️ **Admin Panel**\n\nCurrent Mode: **${next.toUpperCase()}**\nFiles in Queue: ${count}`,
        { parse_mode: 'Markdown', ...getAdminKeyboard(next, count) }
    );
});

// 2. Process Batch Action
bot.action('admin_process', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const files = batchStorage[ctx.from.id];
    if (!files || !files.length) return ctx.answerCbQuery('⚠️ Batch is empty!', { show_alert: true });

    await ctx.reply('⚙️ Processing Automation...');
    
    const groups = {};
    files.forEach(f => {
        const groupKey = getGroupId(f.raw_caption); // Group by cleaned name
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(f);
    });

    for (const k in groups) {
        let txt = "";
        groups[k].forEach(f => {
            // FIX: Removed Diamond symbol, Used cleaned caption
            const cleanName = cleanCaption(f.raw_caption);
            txt += `<a href="${f.link}">${cleanName}</a>\n\n`;
        });
        
        try { 
            await ctx.reply(txt, { parse_mode: 'HTML', disable_web_page_preview: true }); 
        } catch (e) {
            await ctx.reply('❌ Error sending a group.');
        }
    }
    
    delete batchStorage[ctx.from.id];
    
    // Refresh Panel
    await ctx.reply('✅ Automation Complete!', getAdminKeyboard(userModes[ctx.from.id], 0));
});

// 3. Clear Batch Action
bot.action('admin_clear', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    delete batchStorage[ctx.from.id];
    const mode = userModes[ctx.from.id] || 'single';
    
    await ctx.editMessageText(
        `⚙️ **Admin Panel**\n\nBatch Cleared! Queue is empty.`,
        { parse_mode: 'Markdown', ...getAdminKeyboard(mode, 0) }
    );
});

// --- ADMIN UPLOAD LOGIC ---
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Admin Only.');
    
    try {
        // Copy to Channel
        const sent = await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const code = encodePayload(sent.message_id);
        const link = `https://t.me/${ctx.botInfo.username}?start=${code}`;
        const mode = userModes[ctx.from.id] || 'single';
        
        // Get Caption
        let rawCap = ctx.message.caption;
        if (!rawCap && ctx.message.document) rawCap = ctx.message.document.file_name;
        if (!rawCap && ctx.message.video) rawCap = ctx.message.video.file_name;
        if (!rawCap && ctx.message.audio) rawCap = ctx.message.audio.file_name;
        if (!rawCap) rawCap = "Untitled File";

        // Logic
        if (mode === 'single') {
            const cleanName = cleanCaption(rawCap);
            await ctx.reply(`✅ **Saved!**\n📂 ${cleanName}\n🔗 ${link}`, { disable_web_page_preview: true });
        } else {
            if (!batchStorage[ctx.from.id]) batchStorage[ctx.from.id] = [];
            batchStorage[ctx.from.id].push({ raw_caption: rawCap, link: link });
            
            // Update Admin Panel text if possible (Optional, keeping it simple here)
            // Just reply simple ack
            const count = batchStorage[ctx.from.id].length;
            await ctx.reply(`📥 Added to Batch (${count})`);
        }
    } catch (e) { await ctx.reply('❌ Error: Bot not admin in DB Channel.'); }
});

// --- USER & START LOGIC ---
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
    
    // Check Force Sub
    if (!await checkForceSub(ctx, ctx.from.id)) {
        return ctx.reply('⚠️ **Join Channels to Access**', await getJoinButtons(ctx, pl));
    }

    // Process Link
    if (pl) {
        const id = decodePayload(pl);
        if (id) try { await ctx.telegram.copyMessage(ctx.chat.id, CHANNEL_ID, id); } catch(e) { ctx.reply('❌ File gone.'); }
        else ctx.reply('❌ Invalid Link.');
    } else {
        // ADMIN PANEL OPENER
        if (ctx.from.id === ADMIN_ID) {
            const mode = userModes[ctx.from.id] || 'single';
            const count = batchStorage[ctx.from.id] ? batchStorage[ctx.from.id].length : 0;
            
            await ctx.reply(
                `⚙️ **Admin Panel**\n\nControl your bot settings here.`,
                { parse_mode: 'Markdown', ...getAdminKeyboard(mode, count) }
            );
        } else {
            ctx.reply('🤖 Send me a link to get files.');
        }
    }
});

// Vercel Handler
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
