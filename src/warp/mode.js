/**
 * How the providers are reached, read from the configuration and nothing else.
 *
 * Its own module so that the two sides of WARP can both ask without importing
 * each other: the lifecycle (`./index.js`, which starts and stops the tunnel) and
 * the per-request routing (`./egress.js`, which decides who goes through it).
 */

/** Whether WARP is in play at all. Off costs nothing and is still the default. */
export function warpEnabled(config) {
  return Boolean(config?.warp?.enabled);
}

/**
 * What goes through the tunnel once it is on.
 *
 * `always` is what `enabled` has meant since the feature existed, and stays the
 * default for a file that carries no mode. `on-rate-limit` holds the tunnel in
 * reserve: requests leave directly, and only a model the provider answered `429`
 * to is retried through it.
 *
 * @returns {'off'|'always'|'on-rate-limit'}
 */
export function warpMode(config) {
  if (!warpEnabled(config)) return "off";
  return config.warp.mode === "on-rate-limit" ? "on-rate-limit" : "always";
}
