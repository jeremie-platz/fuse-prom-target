module.exports = {
  apps: [
    {
      name: "fuse-prom-target-arbitrum",
      script: "npm",
      args: "run start-target",
      cron_restart: "0 * * * *" // Restart every hour.
    },
    {
      name: "fuse-prom-proxy-arbitrum",
      script: "npm",
      args: "run start-proxy"
    }
  ]
};
