module.exports = {
  server: {
    port: 3750,
    host: 'http://localhost:3750',
    healthEndpoint: '/'
  },
  startupTimeout: 20000,
  healthPollInterval: 500,

  window: {
    width: 1400,
    height: 900,
    title: 'Meshtastic Foreman'
  }
};
