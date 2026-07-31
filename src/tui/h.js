import React from 'react';

/**
 * `createElement` alias used instead of JSX.
 *
 * JSX would need a build step, which would break `node src/index.js` and the
 * dependency-free, buildless story of the rest of the project. `h(...)` keeps
 * the components plain, runnable ESM.
 */
export const h = React.createElement;

export const fragment = (...children) => h(React.Fragment, null, ...children);
