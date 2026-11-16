"use strict";

// Проверка входа и API контакторов через socket.io.
//
//   node tools/smoke-test.js
//   node tools/smoke-test.js http://127.0.0.1:8080
//   node tools/smoke-test.js http://127.0.0.1:8080 --write
//
// Пароль берётся из --password, AUTH_PASSWORD или auth.json рядом с проектом.
// Без --write проверяются только чтение состояния, вход и обработка ошибок.
// С --write дополнительно переключается бойлер (и возвращается обратно).
// Тест паузы насоса выполняется только в dryRun-режиме: на реальном железе
// он бы дёргал контактор.

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const io = require("socket.io-client");

const args = process.argv.slice(2);
const url = args.find((arg) => arg.startsWith("http")) || process.env.URL || "http://127.0.0.1:80";
const allowWrite = args.includes("--write");

function argValue(name) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
        return args[index + 1];
    }
    const prefix = name + "=";
    const inline = args.find((arg) => arg.startsWith(prefix));
    return inline ? inline.slice(prefix.length) : undefined;
}

function readStoredPassword() {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "auth.json"), "utf8"));
        return typeof config.password === "string" ? config.password : "";
    } catch (err) {
        return "";
    }
}

const password = argValue("--password") || process.env.AUTH_PASSWORD || readStoredPassword();

let failures = 0;

function check(name, ok, details) {
    if (ok) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${details ? ` — ${details}` : ""}`);
    }
}

function request(method, requestPath, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        const target = new URL(requestPath, url);
        const lib = target.protocol === "https:" ? https : http;
        const headers = Object.assign({}, opts.headers);
        const body = opts.body;

        if (body !== undefined) {
            headers["Content-Length"] = Buffer.byteLength(body);
        }

        const req = lib.request(target, { method, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8")
            }));
        });

        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("таймаут запроса")));
        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
}

function cookiePairs(setCookie) {
    if (!setCookie) {
        return [];
    }
    return setCookie.map((value) => String(value).split(";")[0]).filter(Boolean);
}

async function login() {
    const body = "password=" + encodeURIComponent(password);
    const response = await request("POST", "/login", {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const cookies = cookiePairs(response.headers["set-cookie"]);

    if ((response.status !== 303 && response.status !== 302) || cookies.length === 0) {
        throw new Error(
            `не удалось войти (HTTP ${response.status}). ` +
            "Пароль задаётся через --password, AUTH_PASSWORD или auth.json"
        );
    }

    return cookies.join("; ");
}

function connect(cookie) {
    const options = {
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
        timeout: 5000
    };
    if (cookie) {
        options.extraHeaders = { Cookie: cookie };
    }
    return io(url, options);
}

function waitForConnect(socket) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("нет соединения (таймаут)")), 6000);
        socket.on("connect", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.on("error", (data) => {
            clearTimeout(timer);
            reject(new Error(`сервер отклонил сокет: ${JSON.stringify(data)}`));
        });
        socket.on("connect_error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function waitForRejection(socket) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, data: { code: "E_TIMEOUT" } }), 6000);
        socket.on("connect", () => {
            clearTimeout(timer);
            resolve({ ok: false, data: { code: "E_CONNECTED" } });
        });
        socket.on("error", (data) => {
            clearTimeout(timer);
            resolve({ ok: true, data: data });
        });
        socket.on("connect_error", (err) => {
            clearTimeout(timer);
            resolve({ ok: true, data: err });
        });
    });
}

function call(socket, event, payload) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, code: "E_TIMEOUT", message: "нет ответа" }), 4000);
        const done = (reply) => {
            clearTimeout(timer);
            resolve(reply);
        };
        if (payload === undefined) {
            socket.emit(event, done);
        } else {
            socket.emit(event, payload, done);
        }
    });
}

function findDevice(state, id) {
    return state && state.devices ? state.devices.find((device) => device.id === id) : null;
}

async function runChecks(socket) {
    const initial = await call(socket, "getDevices");
    check("getDevices отвечает", !!initial && Array.isArray(initial.devices), "нет списка устройств");

    if (!initial || !Array.isArray(initial.devices) || initial.devices.length === 0) {
        throw new Error("Нет устройств: проверьте devices.json и лог сервера");
    }

    check("насос найден", !!findDevice(initial, "pump"));
    check("бойлер найден", !!findDevice(initial, "boiler"));
    check("пускатель котла найден", !!findDevice(initial, "heater"));

    const unknown = await call(socket, "switch", { id: "no-such-device", on: true });
    check("неизвестное устройство отклонено", unknown.ok === false && unknown.code === "E_UNKNOWN_DEVICE", JSON.stringify(unknown));

    const bad = await call(socket, "switch", { id: "pump", on: "yes" });
    check("неверный запрос отклонён", bad.ok === false && bad.code === "E_BAD_REQUEST", JSON.stringify(bad));

    const boiler = findDevice(initial, "boiler");
    const canWrite = !boiler || boiler.dryRun || allowWrite;

    if (canWrite && boiler) {
        const target = !boiler.on;
        const first = await call(socket, "switch", { id: "boiler", on: target });
        check(`бойлер ${target ? "включается" : "выключается"}`, first.ok === true && findDevice(first.devices, "boiler").on === target, JSON.stringify(first));

        const back = await call(socket, "switch", { id: "boiler", on: boiler.on });
        check("бойлер возвращается в исходное состояние", back.ok === true && findDevice(back.devices, "boiler").on === boiler.on, JSON.stringify(back));
    } else if (boiler && !boiler.dryRun) {
        console.log("SKIP  переключения: включите dryRun или передайте --write");
    }

    const pump = findDevice(initial, "pump");
    if (pump && pump.dryRun) {
        // Приводим насос в выключенное состояние, затем включаем дважды подряд.
        if (pump.on) {
            await call(socket, "switch", { id: "pump", on: false });
        }
        const on = await call(socket, "switch", { id: "pump", on: true });
        const tooFast = await call(socket, "switch", { id: "pump", on: false });
        const again = await call(socket, "switch", { id: "pump", on: true });
        check("насос включается", on.ok === true, JSON.stringify(on));
        check("пауза не мешает выключению", tooFast.ok === true, JSON.stringify(tooFast));
        check("повторное включение ждёт паузу", again.ok === false && again.code === "E_RATE", JSON.stringify(again));
    }
}

async function main() {
    console.log(`Проверяю ${url}\n`);

    if (!password) {
        console.error("Пароль не найден: передайте --password, задайте AUTH_PASSWORD или создайте auth.json.");
        process.exit(2);
    }

    const anonymousPage = await request("GET", "/");
    check("без входа страница закрыта",
        anonymousPage.status === 302 && String(anonymousPage.headers.location || "").includes("/login"),
        `HTTP ${anonymousPage.status}`);

    const loginPage = await request("GET", "/login");
    check("страница входа отдаётся",
        loginPage.status === 200 && loginPage.body.includes("name=\"password\""),
        `HTTP ${loginPage.status}`);

    const anonymousSocket = connect(null);
    const rejected = await waitForRejection(anonymousSocket);
    anonymousSocket.close();
    check("сокет без входа отклонён",
        rejected.ok && !!rejected.data && rejected.data.code === "E_UNAUTHORIZED",
        JSON.stringify(rejected.data));

    const cookie = await login();
    check("вход с паролем выполнен", cookie.length > 0, "cookie не получен");

    const page = await request("GET", "/", { headers: { Cookie: cookie } });
    check("страница после входа отдаётся",
        page.status === 200 && page.body.includes("<title>Отопление</title>"),
        `HTTP ${page.status}`);

    const socket = connect(cookie);
    await waitForConnect(socket);
    await runChecks(socket);
    socket.close();

    console.log(`\n${failures === 0 ? "Всё в порядке" : `Провалено проверок: ${failures}`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(`\nОшибка: ${err.message}`);
    process.exit(2);
});
