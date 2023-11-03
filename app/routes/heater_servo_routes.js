const Gpio = require('pigpio').Gpio; //include pigpio to interact with the GPIO

var servo = new Gpio(22, { mode: Gpio.OUTPUT });

module.exports = function (app, log) {
    // Set servo value
    app.post("/heater-servo/:value", function (req, res) {
        const data = req.params.value;
        const servoValue = parseInt(data);
        log.debug(`servo: ${servoValue}`); //output converted to console
        servo.servoWrite(servoValue);
    });
};