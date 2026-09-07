// src/config/logger.js
const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === "production"
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
            return `${timestamp} [${level}]: ${message}${metaStr}`;
          })
        )
  ),
  transports: [
    new winston.transports.Console(),
    // Bounded on purpose. `logs/` lives under /app, which this deployment host-mounts, so an
    // unrotated transport would grow on the server's disk with nothing to stop it — turning
    // "set NODE_ENV=production" into a slow-motion disk-full incident. Winston rotates in place
    // once maxsize is reached and keeps maxFiles generations.
    ...(process.env.NODE_ENV === "production"
      ? [
          new winston.transports.File({
            filename: "logs/error.log", level: "error",
            maxsize: 10 * 1024 * 1024, maxFiles: 5, tailable: true,
          }),
          new winston.transports.File({
            filename: "logs/combined.log",
            maxsize: 20 * 1024 * 1024, maxFiles: 5, tailable: true,
          }),
        ]
      : []),
  ],
});

module.exports = logger;
