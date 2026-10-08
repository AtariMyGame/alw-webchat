const express = require("express");
const path = require("path");
const http = require("http");
const net = require("net");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 6187;

const IRC_HOST = "irc.dal.net";
const IRC_PORT = 6667;

const BOT_NICK = "aLwsc";
const BOT_USER = "aLwsc";
const BOT_REALNAME = "aLwsc WebChat IRC Bot";
const OWNER = "F4R1S";

const CHANNEL_FILE = path.join(__dirname, "channels.json");

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================================================
   CHANNEL DATABASE
   ============================================================ */

let channels = [];

function loadChannels() {
    try {
        if (fs.existsSync(CHANNEL_FILE)) {
            const data = fs.readFileSync(CHANNEL_FILE, "utf8");
            channels = JSON.parse(data);

            if (!Array.isArray(channels)) {
                channels = [];
            }
        }
    } catch (err) {
        console.log("Gagal membaca channels.json:", err.message);
        channels = [];
    }
}

function saveChannels() {
    try {
        fs.writeFileSync(
            CHANNEL_FILE,
            JSON.stringify(channels, null, 2)
        );
    } catch (err) {
        console.log("Gagal menyimpan channels.json:", err.message);
    }
}

loadChannels();

/* ============================================================
   IRC
   ============================================================ */

let ircSocket = null;
let ircBuffer = "";
let connected = false;
let reconnectDelay = 5000;

function ircSend(line) {
    if (!ircSocket || !connected) {
        console.log("IRC belum terhubung:", line);
        return;
    }

    console.log("IRC >", line);
    ircSocket.write(line + "\r\n");
}

function joinSavedChannels() {
    if (channels.length === 0) {
        console.log("Belum ada channel tersimpan.");
        return;
    }

    for (const channel of channels) {
        ircSend(`JOIN ${channel}`);
    }
}

function connectIRC() {
    console.log(`Menghubungkan ke DALnet ${IRC_HOST}:${IRC_PORT}...`);

    ircSocket = net.createConnection(
        {
            host: IRC_HOST,
            port: IRC_PORT
        },
        () => {
            console.log("Terhubung ke DALnet.");

            ircSocket.write(`NICK ${BOT_NICK}\r\n`);
            ircSocket.write(
                `USER ${BOT_USER} 0 * :${BOT_REALNAME}\r\n`
            );

            reconnectDelay = 5000;
        }
    );

    ircSocket.setEncoding("utf8");

    ircSocket.on("data", (data) => {
        ircBuffer += data;

        const lines = ircBuffer.split("\r\n");
        ircBuffer = lines.pop();

        for (const line of lines) {
            if (line.trim()) {
                handleIRCLine(line);
            }
        }
    });

    ircSocket.on("error", (err) => {
        console.log("IRC ERROR:", err.message);
    });

    ircSocket.on("close", () => {
        connected = false;
        console.log("Koneksi DALnet terputus.");

        ircSocket = null;

        console.log(
            `Mencoba reconnect dalam ${reconnectDelay / 1000} detik...`
        );

        setTimeout(connectIRC, reconnectDelay);

        reconnectDelay = Math.min(
            reconnectDelay * 2,
            60000
        );
    });
}

function handleIRCLine(line) {
    console.log("IRC <", line);

    if (line.startsWith("PING")) {
        const value = line.substring(5);
        if (ircSocket) {
            ircSocket.write(`PONG ${value}\r\n`);
        }
        return;
    }

    const match = line.match(
        /^:([^! ]+)!([^ ]+) PRIVMSG ([^ ]+) :(.+)$/
    );

    if (match) {
        const nick = match[1];
        const target = match[3];
        const message = match[4];

        broadcastWebChat({
            type: "irc",
            nick: nick,
            target: target,
            message: message
        });

        handleIRCCommand(nick, target, message);
    }

    if (/^\S+ 001 /.test(line)) {
        connected = true;

        console.log("Bot berhasil login/register ke DALnet.");

        setTimeout(() => {
            joinSavedChannels();
        }, 1000);
    }

    if (/^\S+ 433 /.test(line)) {
        console.log(
            `Nick ${BOT_NICK} sedang digunakan di DALnet.`
        );
    }

    const joinMatch = line.match(
        /^:([^! ]+)!([^ ]+) JOIN :?(.+)$/
    );

    if (joinMatch) {
        broadcastWebChat({
            type: "join",
            nick: joinMatch[1],
            channel: joinMatch[3]
        });
    }

    const partMatch = line.match(
        /^:([^! ]+)!([^ ]+) PART ([^ ]+)/
    );

    if (partMatch) {
        broadcastWebChat({
            type: "part",
            nick: partMatch[1],
            channel: partMatch[3]
        });
    }

    const quitMatch = line.match(
        /^:([^! ]+)!([^ ]+) QUIT/
    );

    if (quitMatch) {
        broadcastWebChat({
            type: "quit",
            nick: quitMatch[1]
        });
    }
}

/* ============================================================
   IRC COMMANDS
   ============================================================ */

function isOwner(nick) {
    return nick.toLowerCase() === OWNER.toLowerCase();
}

function firstChannel() {
    return channels.length > 0 ? channels[0] : null;
}

function commandReply(target, text) {
    ircSend(`PRIVMSG ${target} :${text}`);
}

function handleIRCCommand(nick, target, message) {

    const parts = message.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    /* OWNER COMMANDS */

    if (command === "+chan") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const channel = args[0];

        if (!channel || !channel.startsWith("#")) {
            commandReply(target, "Gunakan: +chan #channel");
            return;
        }

        if (channels.includes(channel)) {
            commandReply(target, `${channel} sudah ada.`);
            return;
        }

        channels.push(channel);
        saveChannels();

        ircSend(`JOIN ${channel}`);

        commandReply(
            target,
            `${channel} berhasil ditambahkan.`
        );

        return;
    }

    if (command === "-chan") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const channel = args[0];

        if (!channel) {
            commandReply(target, "Gunakan: -chan #channel");
            return;
        }

        if (!channels.includes(channel)) {
            commandReply(
                target,
                `${channel} tidak ada dalam daftar.`
            );
            return;
        }

        ircSend(`PART ${channel} :Removed by owner`);

        channels = channels.filter(
            c => c.toLowerCase() !== channel.toLowerCase()
        );

        saveChannels();

        commandReply(
            target,
            `${channel} berhasil dihapus.`
        );

        return;
    }

    if (command === ".chans") {

        if (channels.length === 0) {
            commandReply(target, "Belum ada channel.");
            return;
        }

        commandReply(
            target,
            `Channel: ${channels.join(", ")}`
        );

        return;
    }

    if (command === ".rejoin") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const channel = args[0];

        if (!channel) {
            commandReply(target, "Gunakan: .rejoin #channel");
            return;
        }

        ircSend(`PART ${channel} :Rejoin`);
        
        setTimeout(() => {
            ircSend(`JOIN ${channel}`);
        }, 1000);

        return;
    }

    if (command === ".say") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const text = message.substring(5).trim();

        if (!text) {
            commandReply(target, "Gunakan: .say pesan");
            return;
        }

        commandReply(target, text);
        return;
    }

    if (command === ".msg") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const dest = args[0];
        const text = args.slice(1).join(" ");

        if (!dest || !text) {
            commandReply(
                target,
                "Gunakan: .msg nick pesan"
            );
            return;
        }

        ircSend(`PRIVMSG ${dest} :${text}`);
        return;
    }

    if (command === ".notice") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const dest = args[0];
        const text = args.slice(1).join(" ");

        if (!dest || !text) {
            commandReply(
                target,
                "Gunakan: .notice nick pesan"
            );
            return;
        }

        ircSend(`NOTICE ${dest} :${text}`);
        return;
    }

    if (command === ".kick") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .kick nick");
            return;
        }

        ircSend(
            `KICK ${target} ${user} :Kicked by aLwsc`
        );

        return;
    }

    if (command === ".ban") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .ban nick");
            return;
        }

        ircSend(`MODE ${target} +b ${user}`);
        return;
    }

    if (command === ".unban") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const mask = args[0];

        if (!mask) {
            commandReply(target, "Gunakan: .unban mask");
            return;
        }

        ircSend(`MODE ${target} -b ${mask}`);
        return;
    }

    if (command === ".op") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .op nick");
            return;
        }

        ircSend(`MODE ${target} +o ${user}`);
        return;
    }

    if (command === ".deop") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .deop nick");
            return;
        }

        ircSend(`MODE ${target} -o ${user}`);
        return;
    }

    if (command === ".voice") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .voice nick");
            return;
        }

        ircSend(`MODE ${target} +v ${user}`);
        return;
    }

    if (command === ".devoice") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .devoice nick");
            return;
        }

        ircSend(`MODE ${target} -v ${user}`);
        return;
    }

    if (command === ".topic") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const topic = message.substring(6).trim();

        if (!topic) {
            commandReply(target, "Gunakan: .topic teks");
            return;
        }

        ircSend(`TOPIC ${target} :${topic}`);
        return;
    }

    if (command === ".invite") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const user = args[0];

        if (!user) {
            commandReply(target, "Gunakan: .invite nick");
            return;
        }

        ircSend(`INVITE ${user} ${target}`);
        return;
    }

    if (command === ".mode") {

        if (!isOwner(nick)) {
            commandReply(target, "Perintah ini khusus owner.");
            return;
        }

        const mode = args.join(" ");

        if (!mode) {
            commandReply(target, "Gunakan: .mode +nt");
            return;
        }

        ircSend(`MODE ${target} ${mode}`);
        return;
    }

    if (command === ".status") {

        commandReply(
            target,
            `aLw IRC: ${connected ? "ONLINE" : "OFFLINE"} | Channels: ${channels.length}`
        );

        return;
    }

    if (command === ".ping") {

        commandReply(target, "PONG!");
        return;
    }

    if (command === ".uptime") {

        const seconds = Math.floor(process.uptime());

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor(
            (seconds % 3600) / 60
        );
        const secs = seconds % 60;

        commandReply(
            target,
            `Uptime: ${hours}j ${minutes}m ${secs}d`
        );

        return;
    }

    if (command === ".help") {

        commandReply(
            target,
            "aLw: +chan -chan .chans .rejoin .say .msg .notice .kick .ban .unban .op .deop .voice .devoice .topic .invite .mode .status .ping .uptime"
        );

        return;
    }
}

/* ============================================================
   WEBCHAT
   ============================================================ */

function broadcastWebChat(data) {

    const payload = JSON.stringify(data);

    for (const client of wss.clients) {

        if (client.readyState === 1) {
            client.send(payload);
        }
    }
}

wss.on("connection", (ws) => {

    const webNick =
        "WebUser" +
        Math.floor(1000 + Math.random() * 9000);

    ws.webNick = webNick;

    ws.send(
        JSON.stringify({
            type: "system",
            message:
                `Selamat datang ${webNick} di aLw WebChat.`
        })
    );

    ws.on("message", (raw) => {

        try {

            const data = JSON.parse(
                raw.toString()
            );

            if (data.type === "nick") {

                if (
                    typeof data.nick === "string" &&
                    data.nick.trim()
                ) {

                    ws.webNick =
                        data.nick
                            .trim()
                            .substring(0, 20);

                    ws.send(
                        JSON.stringify({
                            type: "system",
                            message:
                                `Nick diubah menjadi ${ws.webNick}.`
                        })
                    );
                }

                return;
            }

            if (data.type === "message") {

                const message =
                    String(data.message || "").trim();

                if (!message) {
                    return;
                }

                const channel = firstChannel();

                if (!channel) {

                    ws.send(
                        JSON.stringify({
                            type: "system",
                            message:
                                "Belum ada channel IRC yang ditambahkan."
                        })
                    );

                    return;
                }

                ircSend(
                    `PRIVMSG ${channel} :[Web] <${ws.webNick}> ${message}`
                );

                broadcastWebChat({
                    type: "web",
                    nick: ws.webNick,
                    channel: channel,
                    message: message
                });
            }

        } catch (err) {

            console.log(
                "WebSocket error:",
                err.message
            );
        }
    });
});

/* ============================================================
   START
   ============================================================ */

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `aLw WebChat berjalan di port ${PORT}`
    );

    console.log(
        `aLw IRC Bot target: ${IRC_HOST}:${IRC_PORT}`
    );

    connectIRC();
});
