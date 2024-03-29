module.exports = {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  },
  session: {
    secret: "is2Dio5phax0uuhi",
    cookie: "connect.sid",
    ttl: 1
  },
  gate: {
    websocketUrl: process.env.GATE_URL
  },
  appId: process.env.APP_ID,
  appSecretFile: process.env.APP_SECRET_FILE,
  resources: [
    {
      rProperties: "",
      rType: "fp-scanner"
    }
  ]
}