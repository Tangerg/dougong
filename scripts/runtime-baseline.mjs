const browsers = Object.freeze([
  Object.freeze({ manifest: "Chrome >= 119", build: "chrome119" }),
  Object.freeze({ manifest: "Edge >= 119", build: "edge119" }),
  Object.freeze({ manifest: "Firefox >= 121", build: "firefox121" }),
  Object.freeze({ manifest: "Safari >= 17.4", build: "safari17.4" }),
]);

export const developmentEngines = Object.freeze({
  node: "^22.12.0 || ^24.0.0 || >=26.0.0",
});

export const runtimeBaseline = Object.freeze({
  engines: Object.freeze({ node: ">=22" }),
  browserslist: Object.freeze(browsers.map(({ manifest }) => manifest)),
  buildTargets: Object.freeze(browsers.map(({ build }) => build)),
});
