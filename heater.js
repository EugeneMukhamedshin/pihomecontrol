var Gpio = require("pigpio").Gpio;
var heater = new Gpio(27, { mode: Gpio.OUTPUT });

// Включение/выключение котла
function setHeaterActivated(value) {
    heater.digitalWrite(value);
}

process.on("SIGINT", function () { //on ctrl+c
    contactor.unexport(); // Unexport Button GPIO to free resources
    setHeaterActivated(0);
    process.exit(); //exit completely
});

setHeaterActivated(1);