"use strict";

// Диагностика выходов GPIO ровно тем же путём, которым их трогает сервис:
// тот же модуль onoff, тот же sysfs (/sys/class/gpio), те же аргументы.
//
// Запуск на Raspberry Pi:
//     sudo systemctl stop pihomecontrol
//     sudo node tools/gpio-doctor.js          # все устройства из devices.json
//     sudo node tools/gpio-doctor.js 27       # только один BCM-пин
//     sudo node tools/gpio-doctor.js --read-only
//
// Скрипт подаёт на выход 1, читает состояние линии обратно, затем 0 и снова
// читает. Это отвечает на главный вопрос: «пин реально меняется?» — и отделяет
// проблему кода от проблемы монтажа.
//
// ВНИМАНИЕ: реле будут щёлкать. Силовую часть (220 В) лучше отключить.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// BCM -> номер контакта на 40-контактной гребёнке (для проверки монтажа).
const HEADER_PIN = {
    0: 27, 1: 28, 2: 3, 3: 5, 4: 7, 5: 29, 6: 31, 7: 26, 8: 24, 9: 21,
    10: 19, 11: 23, 12: 32, 13: 33, 14: 8, 15: 10, 16: 36, 17: 11, 18: 12,
    19: 35, 20: 38, 21: 40, 22: 15, 23: 16, 24: 18, 25: 22, 26: 37, 27: 13
};

const args = process.argv.slice(2);
const readOnly = args.includes("--read-only");
const onlyPinArg = args.find((arg) => /^\d+$/.test(arg));
const onlyPin = onlyPinArg === undefined ? null : Number(onlyPinArg);

function headerPin(pin) {
    return HEADER_PIN[pin] === undefined ? "?" : `контакт ${HEADER_PIN[pin]}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileIfExists(file) {
    try {
        return fs.readFileSync(file, "utf8").trim();
    } catch (err) {
        return null;
    }
}

function run(command, commandArgs) {
    try {
        return execFileSync(command, commandArgs, { encoding: "utf8", timeout: 5000 }).trim();
    } catch (err) {
        return null;
    }
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function describeSysfs(pin) {
    const dir = `/sys/class/gpio/gpio${pin}`;
    if (!fs.existsSync(dir)) {
        console.log(`  sysfs: ${dir} не экспортирован`);
        return;
    }
    const direction = readFileIfExists(`${dir}/direction`);
    const value = readFileIfExists(`${dir}/value`);
    const activeLow = readFileIfExists(`${dir}/active_low`);
    console.log(`  sysfs: ${dir} direction=${direction} value=${value} active_low=${activeLow}`);
}

function describePinMux(pin) {
    const pinctrl = run("pinctrl", ["get", String(pin)]);
    if (pinctrl !== null) {
        console.log(`  pinctrl: ${pinctrl}`);
        return;
    }
    const raspiGpio = run("raspi-gpio", ["get", String(pin)]);
    if (raspiGpio !== null) {
        console.log(`  raspi-gpio: ${raspiGpio}`);
    }
}

function serviceState(name) {
    const state = run("systemctl", ["is-active", name]);
    return state === null ? "неизвестно" : state;
}

async function main() {
    console.log("gpio-doctor: проверка выходов теми же средствами, что и сервис");
    console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
    console.log(`GPIO_MOCK=${process.env.GPIO_MOCK || "(не задан)"}`);
    console.log(`pihomecontrol: ${serviceState("pihomecontrol")}, pigpiod: ${serviceState("pigpiod")}`);

    const devicesConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "devices.json"), "utf8")
    );

    section("Устройства из devices.json");
    for (const device of devicesConfig.devices || []) {
        const pin = Number(device.pin);
        const dryRun = device.dryRun === undefined ? devicesConfig.dryRun === true : device.dryRun === true;
        const feedback = device.feedbackPin == null ? "нет" : `GPIO${device.feedbackPin}`;
        console.log(
            `${device.id}: GPIO${pin} (${headerPin(pin)}), activeLow=${device.activeLow === true}` +
            `, dryRun=${dryRun}, обратная связь=${feedback}`
        );
    }

    // Частая ошибка монтажа и конфигурации: два устройства на одном пине
    // или вход обратной связи на пине, которым управляют как выходом.
    const usedPins = new Map();
    for (const device of devicesConfig.devices || []) {
        const pin = Number(device.pin);
        if (usedPins.has(pin)) {
            console.log(`\nВНИМАНИЕ: GPIO${pin} указан и у "${usedPins.get(pin)}", и у "${device.id}"`);
        } else {
            usedPins.set(pin, device.id);
        }
        if (device.feedbackPin != null && Number(device.feedbackPin) === pin) {
            console.log(`\nВНИМАНИЕ: у "${device.id}" pin и feedbackPin — один и тот же GPIO${pin}`);
        }
    }

    if (serviceState("pihomecontrol") === "active") {
        console.log("\nСервис запущен и держит GPIO. Остановите его: sudo systemctl stop pihomecontrol");
        console.log("Иначе результат ниже ничего не значит.");
    }

    let onoff;
    try {
        onoff = require("onoff");
    } catch (err) {
        console.log("\nНе удалось загрузить onoff — это не Raspberry Pi или модуль не собран.");
        console.log(String(err && err.message ? err.message : err));
        process.exitCode = 2;
        return;
    }

    if (!onoff.Gpio.accessible) {
        console.log("\nonoff.Gpio.accessible = false: нет прав на /sys/class/gpio/export.");
        console.log("Запустите через sudo или добавьте пользователя в группу gpio.");
    }

    for (const device of devicesConfig.devices || []) {
        const pin = Number(device.pin);
        if (onlyPin !== null && pin !== onlyPin) {
            continue;
        }
        const dryRun = device.dryRun === undefined ? devicesConfig.dryRun === true : device.dryRun === true;

        section(`${device.id}: GPIO${pin} (${headerPin(pin)})`);
        describeSysfs(pin);
        describePinMux(pin);

        if (readOnly) {
            continue;
        }
        if (dryRun) {
            console.log("  dryRun=true — выход не трогаем (уберите dryRun, чтобы проверить реле)");
            continue;
        }

        let gpio = null;
        try {
            gpio = new onoff.Gpio(pin, "out", "none", { activeLow: device.activeLow === true });
            const direction = gpio.direction();
            console.log(`  onoff: direction=${direction}, activeLow=${gpio.activeLow()}`);

            gpio.writeSync(1);
            await sleep(300);
            const high = gpio.readSync();
            console.log(`  записали 1 -> прочитали ${high}`);
            await sleep(2000);

            gpio.writeSync(0);
            await sleep(300);
            const low = gpio.readSync();
            console.log(`  записали 0 -> прочитали ${low}`);
            await sleep(2000);

            if (high === 1 && low === 0) {
                console.log("  ЛИНИЯ МЕНЯЕТСЯ: код и GPIO исправны.");
                console.log("  Если реле при этом не щёлкало — смотрите монтаж: тот ли контакт гребёнки,");
                console.log("  питание модуля реле, перемычка VCC-COM, целостность провода.");
                console.log("  Если щёлкало на «0», а не на «1» — поставьте \"activeLow\": true.");
            } else if (high === 0 && low === 0) {
                console.log("  ЛИНИЯ НЕ МЕНЯЕТСЯ: пин не становится высоким.");
                console.log("  Вероятно: GPIO занят pigpiod или другим процессом, пин уже");
                console.log("  используется overlay/драйвером, либо в devices.json другой номер.");
                console.log("  Проверьте: sudo systemctl stop pigpiod; повтор; pinctrl get " + pin);
            } else {
                console.log("  Странный результат — пришлите этот вывод целиком.");
            }
        } catch (err) {
            console.log(`  ОШИБКА onoff: ${err && err.stack ? err.stack : err}`);
        } finally {
            if (gpio) {
                try {
                    gpio.unexport();
                } catch (err) {
                    // пин мог быть уже освобождён
                }
            }
        }
    }

    section("Что это значит");
    console.log("- «записали 1 -> прочитали 1» значит, что код дошёл до пина.");
    console.log("  Если реле молчит — проблема в проводе/модуле/номере контакта, а не в сервисе.");
    console.log("- BCM27 — это 13-й контакт гребёнки, а не 27-й. Если реле висит на");
    console.log("  физическом контакте 27, это BCM0: в devices.json должен быть pin 0.");
    console.log("- «записали 1 -> прочитали 0» значит, что линию кто-то держит или это не тот пин.");
    console.log("- Щелчок на «0» вместо «1» — у модуля реле инверсный вход, нужен activeLow: true.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
