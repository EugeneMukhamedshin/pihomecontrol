"use strict";

// Слой доступа к GPIO.
// На Raspberry Pi используются реальные pigpio и onoff.
// На обычном компьютере (или в CI) можно запустить с GPIO_MOCK=1 — тогда
// вместо железа работает заглушка, и интерфейс можно отлаживать без Pi.

const USE_MOCK = process.env.GPIO_MOCK === "1";

class MockGpio {
    constructor(pin, direction, edge, options) {
        this.pin = pin;
        this.direction = direction;
        this.edge = edge;
        this.options = options || {};
        this._value = 0;
        if (this.direction === "out" || (this.options && this.options.mode !== undefined)) {
            this._value = 0;
        }
    }

    writeSync(value) {
        this._value = value ? 1 : 0;
    }

    digitalWrite(value) {
        this._value = value ? 1 : 0;
    }

    servoWrite(value) {
        this._value = value;
    }

    pwmWrite(value) {
        this._value = value;
    }

    readSync() {
        return this._value;
    }

    watch() {
        return this;
    }

    unexport() {
        // заглушка: освобождать нечего
    }
}

MockGpio.OUTPUT = 1;
MockGpio.INPUT = 0;

let pigpio;
let onoff;

if (USE_MOCK) {
    pigpio = { Gpio: MockGpio, OUTPUT: MockGpio.OUTPUT };
    onoff = { Gpio: MockGpio };
} else {
    onoff = require("onoff");
    pigpio = null;
}

// pigpio грузим лениво: его gpioInitialise() поднимает библиотеку внутри
// процесса и падает с «error -1», если запущен демон pigpiod (тот держит
// /var/run/pigpio.pid). Раньше require() на старте ронял весь сервис —
// вместе с управлением реле, хотя серво не является обязательным.
function getPigpio() {
    if (USE_MOCK) {
        return pigpio;
    }
    if (!pigpio) {
        pigpio = require("pigpio");
    }
    return pigpio;
}

module.exports = { getPigpio, onoff, USE_MOCK, MockGpio };
