"use strict";

// Проверка реле без силовой нагрузки.
//
// Запуск на Raspberry Pi:
//     sudo node tools/relay-test.js
//     sudo node tools/relay-test.js 23     # только один GPIO
//
// ВАЖНО: остановите сервис (иначе GPIO заняты) и отсоедините 220 В от контакторов.
// Скрипт по очереди подаёт на каждый GPIO логическую 1, потом 0.
// Смотрите, в какой момент щёлкает реле и загорается светодиод модуля:
//   щёлкнуло после "уровень 1" → в devices.json activeLow: false
//   щёлкнуло после "уровень 0" → в devices.json activeLow: true
//
// После проверки верните питание и поставьте в devices.json "dryRun": false.

const path = require("path");
const fs = require("fs");
const { Gpio } = require("onoff");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "devices.json"), "utf8"));
const onlyPin = process.argv[2] ? Number(process.argv[2]) : null;

if (!config.devices || config.devices.length === 0) {
    console.error("В devices.json нет устройств");
    process.exit(1);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    console.log("Тест реле. Силовая нагрузка должна быть отключена!");
    console.log("Для каждого GPIO будет: уровень 1 (2 с) -> уровень 0 (2 с).\n");

    for (const device of config.devices) {
        const pin = Number(device.pin);
        if (onlyPin !== null && pin !== onlyPin) {
            continue;
        }
        if (!Number.isInteger(pin)) {
            console.warn(`Пропуск ${device.id}: не задан pin`);
            continue;
        }

        console.log(`--- ${device.title} (${device.id}), GPIO${pin} ---`);
        const gpio = new Gpio(pin, "out", "none", { activeLow: false });

        try {
            console.log(`GPIO${pin}: уровень 1`);
            gpio.writeSync(1);
            await sleep(2000);
            console.log(`GPIO${pin}: уровень 0`);
            gpio.writeSync(0);
            await sleep(2000);
        } finally {
            try {
                gpio.unexport();
            } catch (err) {
                // pin мог быть уже освобождён
            }
        }
        console.log("");
    }

    console.log("Готово. Если реле щёлкало на уровне 1 — activeLow: false;");
    console.log("если на уровне 0 — activeLow: true. Затем поставьте \"dryRun\": false.");
    console.log("Если реле не щёлкало вообще — проверьте питание модуля и 3,3 В на входах.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
