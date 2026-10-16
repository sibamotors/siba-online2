/**
 * PM2 deployment for the single-process workspace store.
 * Keep instances=1 and fork mode: workspace write serialization is in-process.
 * Secrets belong in .env on the server, never in this file or source control.
 */
module.exports = {
  apps: [
    {
      name: "sibamotor",
      script: "./scripts/start.mjs",
      interpreter: "node",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 10000,
      listen_timeout: 15000,
      merge_logs: true,
      time: true,
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3000",
        NITRO_HOST: "127.0.0.1",
        NITRO_PORT: "3000",
      },
    },
  ],
};
