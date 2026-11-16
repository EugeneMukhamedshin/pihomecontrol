const log4Js = require("log4js");

const express = require("express"); // server for prometheus scrapes
const promClient = require("prom-client"); // prometheus client
const register = promClient.register;
const Gauge = promClient.Gauge;

const temp1Gauge = new Gauge({ name: "temp1_gauge", help: "Living room (top)" });
const temp2Gauge = new Gauge({ name: "temp2_gauge", help: "Kitchen (bottom)" });
const temp3Gauge = new Gauge({ name: "temp3_gauge", help: "Pump box" });
const temp4Gauge = new Gauge({ name: "temp4_gauge", help: "Outside" });
const temp5Gauge = new Gauge({ name: "temp5_gauge", help: "Over the heater" });
const autoTempGauge = new Gauge({ name: "auto_temp_gauge", help: "Auto temp setting" });
const heaterOnGauge = new Gauge({ name: "heater_on_gauge", help: "Heater is on = 1, off = 0" });

var http = require("http").createServer(handler); //require http server, and create server with function handler()
var fs = require("fs"); //require filesystem module
const os = require("os"); // адреса для доступа с телефона
var io = require("socket.io")(http); //require socket.io module and pass the http object (server)
const hardware = require("./lib/hardware");
const { SwitchGroup } = require("./lib/switches");
var Gpio = hardware.pigpio.Gpio;
var dateFormat = require("dateformat");

var servo = new Gpio(22, { mode: Gpio.OUTPUT });

var servoValue = 0;
var currentTemp = NaN;
var contactorValue = 0;
var heaterActivated = 0;

var autoTempValue = 0;
var lowerDelta = 0.5;
var upperDelta = 0.5;
var autoTempSourceIndex = 0;

var debugMode = false;

var tempSensors = [];
tempSensors.push({ name: "Гостиная (потолок)", eng_name: "Living room (top)", path: "/sys/bus/w1/devices/28-00000aa2977d/w1_slave", value: NaN });
tempSensors.push({ name: "Кухня (пол)", eng_name: "Kitchen (bottom)", path: "/sys/bus/w1/devices/28-00000a424adc/w1_slave", value: NaN });
tempSensors.push({ name: "Кессон насоса", eng_name: "Pump box", path: "/sys/bus/w1/devices/28-00000a43105e/w1_slave", value: NaN });
tempSensors.push({ name: "Улица", eng_name: "Outside", path: "/sys/bus/w1/devices/28-00000a40604d/w1_slave", value: NaN });
tempSensors.push({ name: "Над котлом", eng_name: "Over the heater", path: "/sys/bus/w1/devices/28-00000ba683de/w1_slave", value: NaN });

// В mock-режиме (GPIO_MOCK=1) датчиков нет — подставляем правдоподобные значения,
// чтобы можно было проверить гистерезис и интерфейс на обычном компьютере.
if (hardware.USE_MOCK) {
    const mockValues = [26.4, 22.1, 8.4, -3.2, 54.0];
    tempSensors.forEach((sensor, index) => {
        sensor.path = null;
        sensor.mock = true;
        sensor.value = mockValues[index];
    });
}

// Configuring logger
log4Js.configure({
    appenders: {
        server: { type: "dateFile", filename: "homecontrol.log", pattern: ".yyyy-MM-dd", compress: true },
        out: { type: "stdout" }
    },
    categories: { default: { appenders: ["server", "out"], level: "debug" } }
});
const log = log4Js.getLogger("server");

// Каталог для суточных CSV создаём сразу: appendFileSync в несуществующий
// каталог раньше молча ронял цикл логирования.
const dataDir = __dirname + "/data";
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

function logInfo(msg) {
    log.info(msg);
}

function logError(msg, err) {
    if (err === undefined) {
        log.error(msg);
        return;
    }
    // log4js плохо печатает сам объект Error — передаём стек строкой
    log.error(msg, err && err.stack ? err.stack : err);
}

// config
fs.readFile(__dirname + "/config.txt", "utf8", function (err, contents) {
    if (err) {
        contents = "600";
        console.error(err);
    }
    var values = contents.split(";");

    servoValue = parseInt(values[0]);
    if (!Number.isFinite(servoValue)) {
        servoValue = 0;
    }

    autoTempValue = values.length > 1 ? parseFloat(values[1]) : NaN;
    if (!Number.isFinite(autoTempValue)) {
        autoTempValue = 15;
    }

    // Раньше при трёх полях в файле upperDelta становился NaN, и верхний
    // порог переставал срабатывать: котёл грел без ограничения.
    lowerDelta = values.length > 2 ? parseFloat(values[2]) : NaN;
    upperDelta = values.length > 3 ? parseFloat(values[3]) : NaN;
    if (!Number.isFinite(lowerDelta) || lowerDelta < 0) {
        lowerDelta = 0.5;
    }
    if (!Number.isFinite(upperDelta) || upperDelta < 0) {
        upperDelta = 0.5;
    }

    autoTempSourceIndex = values.length > 4 ? parseInt(values[4]) : 0;
    if (!Number.isInteger(autoTempSourceIndex) ||
        autoTempSourceIndex < 0 ||
        autoTempSourceIndex >= tempSensors.length) {
        autoTempSourceIndex = 0;
    }

    servo.servoWrite(servoValue);
    logInfo(`Read from config: ${contents}. Parsed: Servo=${servoValue} AutoTemp=${autoTempValue} lowerDelta=${lowerDelta} upperDelta=${upperDelta}`);
    if (!err) {
        // Нормализуем файл (например, если в нём было только 3 поля).
        // При ошибке чтения не перезаписываем: иначе можно потерять уставки.
        writeConfig();
    }
});

// Удалённые контакторы: насос и бойлер (настройки в devices.json).
// Ошибка здесь не должна ронять управление котлом.
let switches = null;
try {
    const devicesConfig = JSON.parse(fs.readFileSync(__dirname + "/devices.json", "utf8"));
    switches = new SwitchGroup({
        devices: devicesConfig.devices,
        stateFile: devicesConfig.stateFile,
        dryRun: devicesConfig.dryRun,
        mock: hardware.USE_MOCK,
        gpio: hardware.onoff,
        log: log,
        baseDir: __dirname
    });
    // Нагрев теперь тоже контактор: синхронизируем переменные и метрику
    switches.onDeviceChange = handleDeviceChange;
    syncHeater();
    logInfo(`Remote switches initialized: ${switches.snapshot().devices.map(d => d.id).join(", ")}`);
} catch (err) {
    logError("Failed to initialize remote switches (devices.json)", err);
}

// server
const httpPort = process.env.PORT ? parseInt(process.env.PORT) : 80;
http.listen(httpPort, function () {
    // Подсказываем адрес, по которому страница откроется с телефона в той же сети
    const addresses = [];
    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach(function (name) {
        (interfaces[name] || []).forEach(function (info) {
            if (info.family === "IPv4" && !info.internal) {
                addresses.push(`${name}: http://${info.address}:${httpPort}`);
            }
        });
    });
    logInfo(`Listening ${httpPort} port. Открыть с телефона: ${addresses.length ? addresses.join(", ") : "нет сетевых адресов"}`);
});
http.on("error", function (err) {
    // Порт занят — не роняем управление отоплением, просто не будет веб-интерфейса
    logError(`HTTP server error on port ${httpPort}`, err);
});

function handler(req, res) { //what to do on requests to port 8080
    logInfo("Got request, sending response");
    fs.readFile(__dirname + "/public/homecontrol.html", function (err, data) { //read file rgb.html in public folder
        if (err) {
            res.writeHead(404, { 'Content-Type': "text/html" }); //display 404 on error
            return res.end("404 Not Found");
        }
        res.writeHead(200, { 'Content-Type': "text/html" }); //write HTML
        res.write(data); //write data from rgb.html
        return res.end();
    });
}

// Отправка данных всем подписанным
function emitValues(socket) {
    logInfo(`Emitting Temp=${currentTemp} Servo=${servoValue} AutoTemp=${autoTempValue} Contactor=${contactorValue} Heater=${heaterActivated}`);
    socket.emit("currentTemp", currentTemp);
    socket.emit("servo", servoValue);
    socket.emit("contactor", contactorValue);
    socket.emit("heater", heaterActivated);
    socket.emit("tempSensors", tempSensors);

    socket.emit("autoTemp", autoTempValue);
    socket.emit("lowerDelta", lowerDelta);
    socket.emit("upperDelta", upperDelta);
    socket.emit("autoTempSourceIndex", autoTempSourceIndex);
    if (switches) {
        socket.emit("devices", switches.snapshot());
    }
}

function writeConfig() {
    const file = __dirname + "/config.txt";
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, `${servoValue.toString()};${autoTempValue.toString()};${lowerDelta.toString()};${upperDelta.toString()};${autoTempSourceIndex.toString()}`);
    fs.renameSync(tmp, file); // атомарная замена: не оставляет половину файла
}

var connectionsCount = 0;

// sockets
io.sockets.on("connection", function (socket) {
    // Web Socket Connection
    connectionsCount++;
    logInfo(`Client connected. Connections count = ${connectionsCount}`);

    // read and set servo value
    socket.on("servo", function (data) {
        const value = parseInt(data, 10);
        if (!Number.isInteger(value) || value < 0 || value > 2500) {
            logError(`servo: недопустимое значение ${data}`);
            return;
        }
        servoValue = value;
        writeConfig();
        logInfo(`servo: ${servoValue}`); //output converted to console
        servo.servoWrite(servoValue);
    });

    // read and set autoTemp value
    socket.on("autoTemp", function (data) {
        const value = parseFloat(String(data).replace(",", "."));
        if (!Number.isFinite(value) || value < 0 || value > 60) {
            logError(`autoTemp: недопустимое значение ${data}`);
            return;
        }
        autoTempValue = value;
        writeConfig();
        logInfo(`autoTemp: ${autoTempValue}`); //output converted to console
    });

    // read and set lowerDelta value
    socket.on("lowerDelta", function (data) {
        const value = parseFloat(data);
        if (!Number.isFinite(value) || value < 0) {
            logError(`lowerDelta: недопустимое значение ${data}`);
            return;
        }
        lowerDelta = value;
        writeConfig();
        logInfo(`lowerDelta: ${lowerDelta}`); //output converted to console
    });

    // read and set upperDelta value
    socket.on("upperDelta", function (data) {
        const value = parseFloat(data);
        if (!Number.isFinite(value) || value < 0) {
            logError(`upperDelta: недопустимое значение ${data}`);
            return;
        }
        upperDelta = value;
        writeConfig();
        logInfo(`upperDelta: ${upperDelta}`); //output converted to console
    });

    // read and set autoTempSourceIndex value
    socket.on("autoTempSourceIndex", function (data) {
        const value = parseInt(data, 10);
        if (!Number.isInteger(value) || value < 0 || value >= tempSensors.length) {
            logError(`autoTempSourceIndex: недопустимое значение ${data}`);
            return;
        }
        autoTempSourceIndex = value;
        writeConfig();
        logInfo(`autoTempSourceIndex: ${autoTempSourceIndex}`); //output converted to console
    });

    // Старое событие оставлено для совместимости: теперь это тот же switch
    socket.on("heater", function (data) {
        if (!switches) {
            return;
        }
        const on = parseInt(data, 10) === 1;
        const result = switches.set("heater", on, `веб-интерфейс ${socket.handshake.address}`);
        if (result.ok) {
            io.emit("devices", switches.snapshot());
        }
        logInfo(`heater: ${on ? "on" : "off"}${result.ok ? "" : ` (${result.code})`}`);
    });

    // Удалённое управление контакторами насоса и бойлера.
    // Клиент получает подтверждение (ack) или код ошибки.
    socket.on("switch", function (data, callback) {
        const reply = typeof callback === "function" ? callback : function () { };
        if (!switches) {
            return reply({ ok: false, code: "E_NOT_READY", message: "Контакторы не инициализированы" });
        }
        if (!data || typeof data.id !== "string" || typeof data.on !== "boolean") {
            return reply({ ok: false, code: "E_BAD_REQUEST", message: "Неверная команда" });
        }

        logInfo(`switch: ${data.id} -> ${data.on ? "on" : "off"} (client ${socket.handshake.address})`);
        const result = switches.set(data.id, data.on, `веб-интерфейс ${socket.handshake.address}`);
        if (!result.ok) {
            logError(`switch rejected: ${data.id}=${data.on}: ${result.message}`);
            return reply(result);
        }

        const state = switches.snapshot();
        io.emit("devices", state);
        return reply({ ok: true, devices: state });
    });

    socket.on("getDevices", function (callback) {
        if (typeof callback === "function") {
            callback(switches ? switches.snapshot() : { ts: Date.now(), dryRun: false, devices: [] });
        }
    });

    emitValues(socket);

    // emit variables
    let interval = setInterval(() => {
        if (socket.connected)
            emitValues(socket);
        else {
            clearInterval(interval);
            connectionsCount--;
            logInfo(`Client disconnected. Connections count = ${connectionsCount}`);
        }
    }, 15000);
});

function logValues() {
    const tempSensor1Value = tempSensors[0].value.toFixed(2).replace(".", ",");
    const tempSensor2Value = tempSensors[1].value.toFixed(2).replace(".", ",");
    const tempSensor3Value = tempSensors[2].value.toFixed(2).replace(".", ",");
    const tempSensor4Value = tempSensors[3].value.toFixed(2).replace(".", ",");
    const tempSensor5Value = tempSensors[4].value.toFixed(2).replace(".", ",");

    temp1Gauge.set(tempSensors[0].value);
    temp2Gauge.set(tempSensors[1].value);
    temp3Gauge.set(tempSensors[2].value);
    temp4Gauge.set(tempSensors[3].value);
    temp5Gauge.set(tempSensors[4].value);
    autoTempGauge.set(autoTempValue);

    const autoTempStr = autoTempValue.toFixed(2).replace(".", ",");
    const lowerDeltaStr = lowerDelta.toFixed(2).replace(".", ",");
    const upperDeltaStr = upperDelta.toFixed(2).replace(".", ",");
    const now = new Date();
    const datestr = dateFormat(now, "yyyymmdd");
    const timestr = dateFormat(now, "dd.mm.yyyy HH:MM:ss");
    fs.appendFileSync(`${dataDir}/${datestr}.csv`,
        `${timestr};${autoTempStr};${lowerDeltaStr};${upperDeltaStr};${heaterActivated};${contactorValue};${tempSensor1Value};${tempSensor2Value};${tempSensor3Value};${tempSensor4Value};${tempSensor5Value};${autoTempSourceIndex};\r\n`);
}


// Включение/выключение котла через общий контактор (GPIO27, обратная связь GPIO17)
function setHeaterActivated(value, reason) {
    value = value ? 1 : 0;
    if (!switches) {
        logError("heater: контакторы не инициализированы, команда пропущена");
        return false;
    }
    const result = switches.set("heater", value === 1, reason || "автоматика");
    if (!result.ok) {
        logInfo(`heater: ${result.code} — ${result.message}`);
        return false;
    }
    logInfo(`Set heater activated value = ${heaterActivated} (${reason || "автоматика"})`);
    return true;
}

function syncHeater() {
    if (!switches) {
        return;
    }
    const heaterSwitch = switches.get("heater");
    if (!heaterSwitch) {
        return;
    }
    heaterActivated = heaterSwitch.on ? 1 : 0;
    if (heaterSwitch.feedback !== null) {
        contactorValue = heaterSwitch.feedback ? 1 : 0;
    } else if (hardware.USE_MOCK) {
        // на ПК обратной связи нет — для логов и метрик повторяем команду
        contactorValue = heaterActivated;
    }
    heaterOnGauge.set(contactorValue);
}

function handleDeviceChange(device) {
    if (!device || device.id !== "heater") {
        return;
    }
    syncHeater();
    if (io) {
        io.emit("devices", switches.snapshot());
    }
}

let invalidTempCycles = 0;

function controlHeater() {
    if (!Number.isFinite(currentTemp)) {
        invalidTempCycles++;
        if (invalidTempCycles >= 3 && heaterActivated !== 0) {
            logError(`Температура недостоверна ${invalidTempCycles} циклов подряд — выключаю нагрев`);
            setHeaterActivated(0, "нет достоверной температуры");
        }
        return;
    }
    invalidTempCycles = 0;
    if (currentTemp >= autoTempValue + upperDelta && heaterActivated !== 0) {
        setHeaterActivated(0, `t=${currentTemp} >= ${autoTempValue + upperDelta}`);
    }
    if (currentTemp <= autoTempValue - lowerDelta && heaterActivated !== 1) {
        setHeaterActivated(1, `t=${currentTemp} <= ${autoTempValue - lowerDelta}`);
    }
}

// temperature sensors
// Формат w1_slave:
//   72 01 4b 46 7f ff 0e 10 57 : crc=57 YES
//   72 01 4b 46 7f ff 0e 10 57 t=23125
// CRC проверяем обязательно: без него датчик может отдавать мусор.
function parseW1Slave(contents) {
    const lines = String(contents).trim().split(/\r?\n/);
    if (lines.length < 2) {
        return null;
    }
    if (!/YES\s*$/i.test(lines[0])) {
        return null;
    }
    const match = lines[1].match(/t=(-?\d+)/);
    if (!match) {
        return null;
    }
    const value = parseInt(match[1], 10) / 1000;
    if (!Number.isFinite(value) || value <= -55 || value >= 125) {
        return null;
    }
    return value;
}

setInterval(async () => {
    // Ждём все чтения, чтобы currentTemp брался из свежих значений, а не из прошлого цикла.
    await Promise.all(tempSensors.map(async (tempSensor, index) => {
        if (!tempSensor.path) {
            // mock-датчик: температура «плывёт» вверх при включённом котле
            // и вниз при выключенном, чтобы был виден цикл гистерезиса
            if (tempSensor.mock) {
                if (index === autoTempSourceIndex) {
                    const drift = heaterActivated ? 0.5 : -0.5;
                    tempSensor.value = Math.round((tempSensor.value + drift) * 10) / 10;
                }
                tempSensor.lastOkAt = Date.now();
            }
            return;
        }
        try {
            const contents = await fs.promises.readFile(tempSensor.path, "utf8");
            const sensorValue = parseW1Slave(contents);
            if (sensorValue === null) {
                tempSensor.failures = (tempSensor.failures || 0) + 1;
            } else {
                tempSensor.value = sensorValue;
                tempSensor.failures = 0;
                tempSensor.lastOkAt = Date.now();
            }
        } catch (err) {
            tempSensor.failures = (tempSensor.failures || 0) + 1;
            logError(`Error reading file ${tempSensor.path}`, err);
        }
        if ((tempSensor.failures || 0) >= 3 && !Number.isNaN(tempSensor.value)) {
            logError(`Датчик "${tempSensor.name}" недостоверен, значение скрыто`);
            tempSensor.value = NaN;
        }
    }));

    currentTemp = tempSensors[autoTempSourceIndex].value;
    logValues();
    controlHeater();
}, hardware.USE_MOCK ? 10000 : 30000); // в mock-режиме цикл быстрее, чтобы демо было видно

// Корректная остановка: гасим все выходы, иначе после падения процесса
// pigpio может оставить последний уровень на GPIO и котёл останется включённым.
function shutdown(reason) {
    logInfo(`Shutdown (${reason})`);
    try {
        if (switches) {
            switches.stop();
        }
    } catch (err) {
        logError("Error while switching off contacts", err);
    }
    process.exit(0); //exit completely
}

process.on("SIGINT", function () { //on ctrl+c
    shutdown("SIGINT");
});

process.on("SIGTERM", function () {
    shutdown("SIGTERM");
});

process.on("uncaughtException", function (err) {
    logError("uncaughtException", err);
    shutdown("uncaughtException");
});

process.on("unhandledRejection", function (err) {
    logError("unhandledRejection", err);
});

// Setup server to Prometheus scrapes:
const server = express();

server.get("/metrics", async (req, res) => {
    try {
        res.set("Content-Type", register.contentType);
        res.end(await register.metrics());
    } catch (ex) {
        res.status(500).end(ex);
    }
});

const port = process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT) : 9000;
console.log(
    `Server listening to ${port}, metrics exposed on /metrics endpoint`,
);
server.on("error", function (err) {
    // Метрики не критичны: при занятом порте просто пишем в лог
    logError(`Metrics server error on port ${port}`, err);
});
server.listen(port);
