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
var io = require("socket.io")(http); //require socket.io module and pass the http object (server)
var Gpio = require("pigpio").Gpio;
var OnOffGpio = require("onoff").Gpio;
var dateFormat = require("dateformat");

var servo = new Gpio(22, { mode: Gpio.OUTPUT });
var contactor = new OnOffGpio(17, "in", "both"); //use GPIO pin 17 as input, and 'both' button presses, and releases should be handled
var heater = new Gpio(27, { mode: Gpio.OUTPUT });

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

// Configuring logger
log4Js.configure({
    appenders: {
        server: { type: "dateFile", filename: "homecontrol.log", pattern: ".yyyy-MM-dd", compress: true },
        out: { type: "stdout" }
    },
    categories: { default: { appenders: ["server", "out"], level: "debug" } }
});
const log = log4Js.getLogger("server");

function logInfo(msg) {
    log.info(msg);
}

function logError(msg, err) {
    log.error(err);
}

// config
fs.readFile("config.txt", "utf8", function (err, contents) {
    if (err) {
        contents = "600";
        console.error(err);
    }
    var values = contents.split(";");
    servoValue = parseInt(values[0]);
    if (values.length > 1) {
        autoTempValue = parseFloat(values[1]);
    } else {
        autoTempValue = 15;
    }
    if (values.length > 2) {
        lowerDelta = parseFloat(values[2]);
        upperDelta = parseFloat(values[3]);
    } else {
        lowerDelta = 0.5;
        upperDelta = 0.5;
    }
    if (values.length > 4) {
        autoTempSourceIndex = parseInt(values[4]);
    } else {
        autoTempSourceIndex = 0;
    }
    servo.servoWrite(servoValue);
    logInfo(`Read from config: ${contents}. Parsed: Servo=${servoValue} AutoTemp=${autoTempValue} lowerDelta=${lowerDelta} upperDelta=${upperDelta}`);
});

// server
http.listen(80); //listen to port 80
logInfo("Listening 80 port");
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
}

function writeConfig() {
    fs.writeFile(__dirname + "/config.txt", `${servoValue.toString()};${autoTempValue.toString()};${lowerDelta.toString()};${upperDelta.toString()};${autoTempSourceIndex.toString()}`);
}

var connectionsCount = 0;

// sockets
io.sockets.on("connection", function (socket) {
    // Web Socket Connection
    connectionsCount++;
    logInfo(`Client connected. Connections count = ${connectionsCount}`);

    // read and set servo value
    socket.on("servo", function (data) {
        servoValue = parseInt(data);
        writeConfig();
        logInfo(`servo: ${servoValue}`); //output converted to console
        servo.servoWrite(servoValue);
    });

    // read and set autoTemp value
    socket.on("autoTemp", function (data) {
        autoTempValue = parseFloat(data);
        writeConfig();
        logInfo(`autoTemp: ${autoTempValue}`); //output converted to console
    });

    // read and set lowerDelta value
    socket.on("lowerDelta", function (data) {
        lowerDelta = parseFloat(data);
        writeConfig();
        logInfo(`lowerDelta: ${lowerDelta}`); //output converted to console
    });

    // read and set upperDelta value
    socket.on("upperDelta", function (data) {
        upperDelta = parseFloat(data);
        writeConfig();
        logInfo(`upperDelta: ${upperDelta}`); //output converted to console
    });

    // read and set autoTempSourceIndex value
    socket.on("autoTempSourceIndex", function (data) {
        autoTempSourceIndex = parseInt(data);
        writeConfig();
        logInfo(`autoTempSourceIndex: ${autoTempSourceIndex}`); //output converted to console
    });

    socket.on("heater",
        function(data) {
            heaterActivated = parseInt(data);
            logInfo(`heater: ${heaterActivated}`);
            heater.digitalWrite(heaterActivated);
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
    fs.appendFile(`data/${datestr}.csv`,
        `${timestr};${autoTempStr};${lowerDeltaStr};${upperDeltaStr};${heaterActivated};${contactorValue};${tempSensor1Value};${tempSensor2Value};${tempSensor3Value};${tempSensor4Value};${tempSensor5Value};${autoTempSourceIndex};\r\n`);
}


// Включение/выключение котла
function setHeaterActivated(value) {
    logInfo(`Set heater activated value = ${value}`);
    heaterActivated = value;
    heater.digitalWrite(heaterActivated);
}

function controlHeater() {
    if (isNaN(currentTemp))
        return;
    if (currentTemp >= autoTempValue + upperDelta && heaterActivated !== 0) {
        setHeaterActivated(0);
    }
    if (currentTemp <= autoTempValue - lowerDelta && heaterActivated !== 1) {
        setHeaterActivated(1);
    }
}

// temperature sensors
setInterval(() => {
    tempSensors.forEach(tempSensor => {
        if (!tempSensor.path)
            return;
        logInfo(`Reading file ${tempSensor.path}`);
        fs.readFile(tempSensor.path,
            "utf8",
            function (err, contents) {
                if (err) {
                    logError(`Error reading file ${tempSensor.path}`, err);
                    return;
                }
                try {
                    logInfo(contents);
                    const i = contents.search("t=\d*");
                    const sensorValue = parseInt(contents.substring(i + 2, contents.length)) / 1000;
                    logInfo(sensorValue);
                    if (sensorValue === 0)
                        return;
                    if (sensorValue >= 500)
                        return;
                    if (sensorValue <= -500)
                        return;
                    tempSensor.value = sensorValue;
                } catch (err) {
                    logError(`Error during parse temp sensor data and set value`, err);
                }
            });
    });
    currentTemp = tempSensors[autoTempSourceIndex].value;
    logValues();
    controlHeater();
}, 30000);

contactor.watch(function (err, value) { 
    if (err) {
        logError("There was an error", err); 
        return;
    }
    contactorValue = value;
    heaterOnGauge.set(value);
});

process.on("SIGINT", function () { //on ctrl+c
    contactor.unexport(); // Unexport Button GPIO to free resources
    setHeaterActivated(0);
    process.exit(); //exit completely
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

const port = 9000;
console.log(
    `Server listening to ${port}, metrics exposed on /metrics endpoint`,
);
server.listen(port);