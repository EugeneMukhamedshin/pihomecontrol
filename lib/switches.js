"use strict";

// Контакторы с ручным удалённым управлением: насос и бойлер.
// Никакой автоматики здесь нет — у обоих устройств она своя.
// Задача модуля: включить/выключить, не дать «дребезжать», сохранить
// состояние между перезапусками и корректно погасить выходы при остановке.

const fs = require("fs");
const path = require("path");

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        return null;
    }
}

function writeJsonAtomic(file, data) {
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

class RemoteSwitch {
    constructor(options) {
        const { Gpio } = options.gpio;

        this.id = options.id;
        this.title = options.title || options.id;
        this.pin = Number(options.pin);
        this.activeLow = options.activeLow === true;
        this.minOnSec = Number(options.minOnSec) || 0;
        this.minOffSec = Number(options.minOffSec) || 0;
        this.restoreOnStart = options.restoreOnStart !== false;
        this.dryRun = options.dryRun === true;
        this.mock = options.mock === true;
        this.feedbackPin = options.feedbackPin == null ? null : Number(options.feedbackPin);
        // Схема aux-контакта может быть любой: с подтяжкой к 3,3 В и замыканием
        // на GND «замкнуто» читается как 0. Тогда поставьте feedbackActiveLow.
        this.feedbackActiveLow = options.feedbackActiveLow === true;
        this.log = options.log;
        this.onChange = options.onChange || function () { };

        this.on = false;
        this.reason = "старт";
        this.lastChangeAt = 0;
        this.feedback = null;
        this.output = null;
        this.feedbackInput = null;
        // Что реально вернул выход после записи. null — прочитать не удалось.
        this.pinValue = null;
        this.readbackSupported = null;

        if (!Number.isInteger(this.pin)) {
            throw new Error(`[${this.id}] в devices.json не задан pin`);
        }

        if (this.dryRun) {
            this.log.warn(`[switch:${this.id}] dryRun: GPIO${this.pin} не управляется`);
            return;
        }

        // Безопасный старт: сначала выключаем, потом читаем сохранённое состояние.
        this.output = new Gpio(this.pin, "out", "none", { activeLow: this.activeLow });
        this.output.writeSync(0);
        this.log.info(`[switch:${this.id}] выход GPIO${this.pin}` +
            `${this.activeLow ? " (activeLow)" : ""}` +
            `${this.feedbackPin === null ? "" : `, обратная связь GPIO${this.feedbackPin}`}`);

        if (this.feedbackPin !== null && !this.mock) {
            this.feedbackInput = new Gpio(this.feedbackPin, "in", "both", { debounceTimeout: 50 });
            this.feedback = this.readFeedback();
            this.feedbackInput.watch((err, value) => {
                if (err) {
                    this.log.error(`[switch:${this.id}] ошибка чтения обратной связи`, err);
                    return;
                }
                this.feedback = this.feedbackActiveLow ? !value : !!value;
                this.onChange(this);
            });
        }
    }

    readFeedback() {
        if (!this.feedbackInput) {
            return null;
        }
        try {
            const value = this.feedbackInput.readSync();
            return this.feedbackActiveLow ? !value : !!value;
        } catch (err) {
            return null;
        }
    }

    // Чтение выхода после записи. На Raspberry Pi sysfs отдаёт текущее
    // состояние линии, поэтому это единственный дешёвый способ увидеть,
    // что команда действительно дошла до пина.
    readOutput() {
        if (!this.output) {
            return null;
        }
        try {
            return this.output.readSync() ? 1 : 0;
        } catch (err) {
            return null;
        }
    }

    writeOutput(on) {
        if (!this.output) {
            return;
        }
        const level = on ? 1 : 0;
        this.output.writeSync(level);
        // Если readSync не поддерживается — останется null и предупреждений не будет.
        if (this.readbackSupported !== false) {
            this.pinValue = this.readOutput();
            if (this.pinValue === null) {
                this.readbackSupported = false;
            } else {
                this.readbackSupported = true;
            }
        }
    }

    apply(on, reason) {
        this.on = !!on;
        const expected = this.on ? 1 : 0;
        this.writeOutput(this.on);
        this.lastChangeAt = Date.now();
        this.reason = reason;
        const pinInfo = this.dryRun ? "" : ` GPIO${this.pin}=${this.pinValue === null ? "?" : this.pinValue}`;
        this.log.info(`[switch:${this.id}] ${this.on ? "ON" : "OFF"}${pinInfo} (${reason})`);
        if (!this.dryRun && this.readbackSupported !== false && this.pinValue !== null && this.pinValue !== expected) {
            // Команда ушла, но линия не изменилась: пин занят другим драйвером,
            // в devices.json указан другой GPIO, либо выход не сконфигурирован.
            this.log.warn(`[switch:${this.id}] GPIO${this.pin}: записали ${expected}, прочитали ${this.pinValue}. ` +
                "Выход не переключается — проверьте pin/activeLow в devices.json, " +
                "что GPIO не занят (pigpiod, старый процесс) и что реле подключено к этому пину.");
        }
        this.onChange(this);
    }

    set(on, reason) {
        on = !!on;
        if (on === this.on) {
            this.reason = reason;
            return { ok: true, changed: false };
        }

        const sinceLast = Date.now() - this.lastChangeAt;
        const waitMs = (on ? this.minOffSec : this.minOnSec) * 1000;
        if (waitMs > 0 && sinceLast < waitMs) {
            const waitSec = Math.ceil((waitMs - sinceLast) / 1000);
            return {
                ok: false,
                code: "E_RATE",
                message: `Слишком часто: подождите ${waitSec} с`
            };
        }

        try {
            this.apply(on, reason);
        } catch (err) {
            this.log.error(`[switch:${this.id}] не удалось переключить GPIO${this.pin}`, err);
            return { ok: false, code: "E_GPIO", message: "Ошибка GPIO, команда не выполнена" };
        }

        return { ok: true, changed: true };
    }

    // Физически выключить, не меняя сохранённое желаемое состояние.
    forceOff() {
        try {
            this.writeOutput(false);
            this.log.info(`[switch:${this.id}] OFF (остановка сервиса)`);
        } catch (err) {
            this.log.error(`[switch:${this.id}] не удалось выключить при остановке`, err);
        }
    }

    snapshot() {
        const now = Date.now();
        return {
            id: this.id,
            title: this.title,
            pin: this.pin,
            on: this.on,
            reason: this.reason,
            feedback: this.feedback,
            mismatch: this.feedback === null ? null : this.feedback !== this.on,
            pinValue: this.pinValue,
            sinceSec: this.lastChangeAt ? Math.round((now - this.lastChangeAt) / 1000) : null,
            minOffSec: this.minOffSec,
            dryRun: this.dryRun
        };
    }

    stop() {
        this.forceOff();
        try {
            if (this.feedbackInput) {
                this.feedbackInput.unexport();
            }
        } catch (err) {
            // нечего освобождать
        }
        try {
            if (this.output) {
                this.output.unexport();
            }
        } catch (err) {
            // нечего освобождать
        }
    }
}

class SwitchGroup {
    constructor(options) {
        this.log = options.log;
        this.baseDir = options.baseDir || process.cwd();
        this.dryRun = options.dryRun === true;
        this.mock = options.mock === true;
        // Сюда подписывается приложение, чтобы синхронизировать нагрев и метрики
        this.onDeviceChange = options.onDeviceChange || function () { };
        this.stateFile = path.resolve(this.baseDir, options.stateFile || "state.json");
        this.devices = new Map();
        this.saved = readJson(this.stateFile) || {};

        const list = options.devices || [];
        for (const cfg of list) {
            const device = new RemoteSwitch({
                id: cfg.id,
                title: cfg.title,
                pin: cfg.pin,
                activeLow: cfg.activeLow,
                minOnSec: cfg.minOnSec,
                minOffSec: cfg.minOffSec,
                restoreOnStart: cfg.restoreOnStart,
                feedbackPin: cfg.feedbackPin,
                feedbackActiveLow: cfg.feedbackActiveLow,
                dryRun: cfg.dryRun === undefined ? this.dryRun : cfg.dryRun === true,
                mock: this.mock,
                gpio: options.gpio,
                log: this.log,
                onChange: (device) => {
                    this.persist();
                    this.onDeviceChange(device);
                }
            });
            this.devices.set(device.id, device);
        }

        // Восстанавливаем только то, что было включено до перезапуска.
        for (const device of this.devices.values()) {
            const saved = this.saved.devices && this.saved.devices[device.id];
            if (!device.restoreOnStart || !saved || !saved.on) {
                continue;
            }
            try {
                device.apply(true, "восстановлено после перезапуска");
            } catch (err) {
                this.log.error(`[switch:${device.id}] не удалось восстановить состояние`, err);
            }
        }
    }

    persist() {
        const data = { updatedAt: new Date().toISOString(), devices: {} };
        for (const [id, device] of this.devices) {
            data.devices[id] = { on: device.on, reason: device.reason };
        }
        try {
            writeJsonAtomic(this.stateFile, data);
        } catch (err) {
            this.log.error("Не удалось сохранить state.json", err);
        }
    }

    get(id) {
        return this.devices.get(id);
    }

    set(id, on, reason) {
        const device = this.devices.get(id);
        if (!device) {
            return { ok: false, code: "E_UNKNOWN_DEVICE", message: "Неизвестное устройство" };
        }
        return device.set(on, reason);
    }

    snapshot() {
        const devices = [];
        let anyDryRun = false;
        for (const device of this.devices.values()) {
            devices.push(device.snapshot());
            if (device.dryRun) {
                anyDryRun = true;
            }
        }
        return { ts: Date.now(), dryRun: anyDryRun, devices };
    }

    stop() {
        for (const device of this.devices.values()) {
            try {
                device.stop();
            } catch (err) {
                this.log.error(`[switch:${device.id}] ошибка при остановке`, err);
            }
        }
    }
}

module.exports = { RemoteSwitch, SwitchGroup };
