"use strict";

// Минимальная аутентификация без внешних зависимостей.
//
// Один пароль на всё приложение. После входа сервер ставит HttpOnly-cookie
// с меткой времени и HMAC-подписью, поэтому база данных и память сессий не
// нужны. Пароль и секрет подписи хранятся в auth.json (в git не попадает)
// либо задаются переменными окружения AUTH_PASSWORD / AUTH_SECRET.
//
// Схема сознательно простая: пользователей и ролей нет, смена пароля
// инвалидирует все выданные cookie (ключ подписи зависит от пароля).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_COOKIE_NAME = "hc_session";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 60 * 1000;

// Без похожих символов (0/O, 1/l/I), чтобы пароль было легко набрать с телефона.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomPassword() {
    const bytes = crypto.randomBytes(16);
    let password = "";
    for (let i = 0; i < bytes.length; i++) {
        password += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    }
    return password.match(/.{4}/g).join("-");
}

function randomSecret() {
    return crypto.randomBytes(32).toString("hex");
}

// Сравниваем хэши: timingSafeEqual требует одинаковую длину и не должен
// выдавать длину настоящего пароля.
function safeEqual(left, right) {
    const a = crypto.createHash("sha256").update(String(left)).digest();
    const b = crypto.createHash("sha256").update(String(right)).digest();
    return crypto.timingSafeEqual(a, b);
}

function toBase64Url(buffer) {
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function readCookie(header, name) {
    if (!header) {
        return null;
    }
    const parts = String(header).split(";");
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const eq = part.indexOf("=");
        if (eq < 0) {
            continue;
        }
        if (part.slice(0, eq).trim() === name) {
            return part.slice(eq + 1).trim();
        }
    }
    return null;
}

function readConfig(file, log) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("ожидался JSON-объект");
        }
        return parsed;
    } catch (err) {
        if (err.code !== "ENOENT") {
            log.error(`Не удалось прочитать ${path.basename(file)}: ${err.message}. Файл будет создан заново.`);
        }
        return {};
    }
}

function writeConfig(file, data, log) {
    try {
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
        try {
            fs.chmodSync(file, 0o600);
        } catch (err) {
            // Windows: права POSIX не поддерживаются, это не ошибка
        }
    } catch (err) {
        log.error(`Не удалось сохранить ${path.basename(file)}: ${err.message}. Пароль будет действовать только до перезапуска.`);
    }
}

function createAuth(options) {
    const opts = options || {};
    const file = opts.file || path.join(__dirname, "..", "auth.json");
    const log = opts.log || console;
    const env = opts.env || process.env;
    const cookieName = opts.cookieName || DEFAULT_COOKIE_NAME;
    const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    const cookieSecure = opts.cookieSecure === undefined
        ? env.AUTH_COOKIE_SECURE === "1"
        : !!opts.cookieSecure;

    const stored = readConfig(file, log);

    // Секрет подписи: окружение важнее файла. Слишком короткий считаем битым.
    // Значение из окружения на диск не пишем — им управляет администратор.
    const envSecret = typeof env.AUTH_SECRET === "string" && env.AUTH_SECRET.trim()
        ? env.AUTH_SECRET.trim()
        : "";
    let secret = envSecret || stored.secret;
    if (typeof secret !== "string" || secret.length < 16) {
        secret = randomSecret();
    }

    // Пароль: окружение важнее файла. Пустой пароль недопустим — иначе вход
    // открыт всем, поэтому в этом случае генерируем новый.
    const envPassword = typeof env.AUTH_PASSWORD === "string" ? env.AUTH_PASSWORD : "";
    let password;
    let passwordSource;
    if (envPassword) {
        password = envPassword;
        passwordSource = "AUTH_PASSWORD";
    } else if (typeof stored.password === "string" && stored.password.length > 0) {
        password = stored.password;
        passwordSource = "auth.json";
    } else {
        password = randomPassword();
        passwordSource = "сгенерирован";
    }

    // Сохраняем только то, что не задано окружением: иначе пароль или секрет
    // неожиданно останутся на диске после смены переменной. Если оба заданы
    // через окружение, auth.json вообще не нужен.
    const fileData = {};
    if (!envSecret) {
        fileData.secret = secret;
    }
    if (!envPassword) {
        fileData.password = password;
    } else if (typeof stored.password === "string" && stored.password.length > 0) {
        // Старый пароль из файла не затираем: он снова понадобится, если
        // AUTH_PASSWORD уберут.
        fileData.password = stored.password;
    }

    const secretChanged = !envSecret && stored.secret !== secret;
    const passwordChanged = !envPassword && stored.password !== password;
    if ((secretChanged || passwordChanged) && Object.keys(fileData).length > 0) {
        writeConfig(file, fileData, log);
    }

    if (passwordSource === "AUTH_PASSWORD") {
        log.info(`Аутентификация включена: пароль из AUTH_PASSWORD${envSecret ? ", секрет из AUTH_SECRET" : ""}`);
    } else if (passwordSource === "auth.json") {
        log.info(`Аутентификация включена: пароль из ${path.basename(file)}`);
    } else {
        log.info(`Аутентификация включена. Пароль создан: ${password} (сохранён в ${path.basename(file)})`);
    }

    // Ключ подписи зависит от пароля: после смены пароля старые cookie
    // перестают проходить проверку.
    const signingKey = crypto
        .createHash("sha256")
        .update(secret)
        .update("\0")
        .update(password)
        .digest();

    function sign(payload) {
        return toBase64Url(crypto.createHmac("sha256", signingKey).update(payload).digest());
    }

    function createToken(nowMs) {
        const exp = (nowMs || Date.now()) + ttlMs;
        return `${exp}.${sign(String(exp))}`;
    }

    function verifyToken(token) {
        if (typeof token !== "string") {
            return false;
        }
        const dot = token.indexOf(".");
        if (dot <= 0 || dot !== token.lastIndexOf(".")) {
            return false;
        }
        const expStr = token.slice(0, dot);
        if (!/^\d{1,16}$/.test(expStr)) {
            return false;
        }
        if (!safeEqual(token.slice(dot + 1), sign(expStr))) {
            return false;
        }
        return Number(expStr) > Date.now();
    }

    function cookieValue(value, maxAgeSec) {
        const parts = [
            `${cookieName}=${value}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${maxAgeSec}`
        ];
        if (maxAgeSec <= 0) {
            parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        }
        if (cookieSecure) {
            parts.push("Secure");
        }
        return parts.join("; ");
    }

    function isAuthenticated(req) {
        const header = req && req.headers ? req.headers.cookie : null;
        return verifyToken(readCookie(header, cookieName));
    }

    function verifyPassword(candidate) {
        return typeof candidate === "string" && safeEqual(candidate, password);
    }

    // --- Ограничение попыток входа -----------------------------------------

    const attempts = new Map();

    function retryAfterSec(ip) {
        const entry = attempts.get(ip);
        if (!entry || !entry.blockedUntil) {
            return 0;
        }
        return Math.max(0, Math.ceil((entry.blockedUntil - Date.now()) / 1000));
    }

    function isRateLimited(ip) {
        return retryAfterSec(ip) > 0;
    }

    function pruneAttempts() {
        if (attempts.size < 500) {
            return;
        }
        const now = Date.now();
        attempts.forEach((entry, ip) => {
            const expiredBlock = entry.blockedUntil && entry.blockedUntil <= now;
            const oldWindow = !entry.blockedUntil && now - entry.firstAt > FAILURE_WINDOW_MS;
            if (expiredBlock || oldWindow) {
                attempts.delete(ip);
            }
        });
    }

    function registerFailure(ip) {
        const now = Date.now();
        let entry = attempts.get(ip);
        if (!entry || now - entry.firstAt > FAILURE_WINDOW_MS) {
            entry = { count: 0, firstAt: now, blockedUntil: 0 };
        }
        entry.count++;
        if (entry.count >= MAX_FAILURES) {
            entry.blockedUntil = now + BLOCK_MS;
            entry.count = 0;
            entry.firstAt = now;
            log.warn(`Слишком много неудачных попыток входа с ${ip}: вход заблокирован на ${Math.round(BLOCK_MS / 1000)} с`);
        } else {
            log.warn(`Неудачная попытка входа с ${ip} (${entry.count} из ${MAX_FAILURES})`);
        }
        attempts.set(ip, entry);
        pruneAttempts();
    }

    function resetFailures(ip) {
        attempts.delete(ip);
    }

    return {
        cookieName,
        configFile: file,
        passwordSource,
        ttlMs,
        isAuthenticated,
        verifyPassword,
        createToken,
        verifyToken,
        loginCookie: function () {
            return cookieValue(createToken(), Math.floor(ttlMs / 1000));
        },
        logoutCookie: function () {
            return cookieValue("", 0);
        },
        isRateLimited,
        retryAfterSec,
        registerFailure,
        resetFailures
    };
}

module.exports = { createAuth };
