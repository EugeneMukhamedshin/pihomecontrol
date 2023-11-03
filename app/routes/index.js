const heaterServoRoutes = require("./heater_servo_routes");

module.exports = function(app, log, config) {
    log.info("Creating routes");
    heaterServoRoutes(app, log);
    log.info("Routes created");
};