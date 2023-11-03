const express = require("express");
const bodyParser = require("body-parser");
const config = require("./config/config");
const log4Js = require("log4js");
var http = require("http");

// Configuring logger
log4Js.configure({
    appenders: { server: { type: "dateFile", filename: "root.log", pattern: ".yyyy-MM-dd", compress: true } },
    categories: { default: { appenders: ["server"], level: "info" } }
});
const log = log4Js.getLogger("server");

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));

// Add headers
app.use(function (req, res, next) {
    // Website you wish to allow to connect
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Request methods you wish to allow
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");

    // Request headers you wish to allow
    res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type");

    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader("Access-Control-Allow-Credentials", true);

    // Pass to next layer of middleware
    next();
});

log.info("Including routes...");
require("./app/routes")(app, log, config);

log.info(`Trying to connect DB (${config.dbUrl})`);

log.info("Start listening...");
http.createServer(app).listen(config.httpPort, function () {
    log.info(`Http server started on ${config.httpPort}`);
});
