const browsers = Object.freeze([
  Object.freeze({ manifest: "Chrome >= 119", build: "chrome119" }),
  Object.freeze({ manifest: "Edge >= 119", build: "edge119" }),
  Object.freeze({ manifest: "Firefox >= 121", build: "firefox121" }),
  Object.freeze({ manifest: "Safari >= 17.4", build: "safari17.4" }),
]);

/** One source of truth for package metadata, emitted syntax and API guards. */
export const runtimeBaseline = Object.freeze({
  engines: Object.freeze({ node: ">=22" }),
  browserslist: Object.freeze(browsers.map(({ manifest }) => manifest)),
  buildTargets: Object.freeze(browsers.map(({ build }) => build)),
});
