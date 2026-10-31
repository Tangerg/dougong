const browsers = { Chrome: "119", Edge: "119", Firefox: "121", Safari: "17.4" };

export const developmentEngines = Object.freeze({
  node: "^22.12.0 || ^24.0.0 || >=26.0.0",
});

export const runtimeBaseline = Object.freeze({
  engines: Object.freeze({ node: ">=22" }),
  browserslist: Object.freeze(
    Object.entries(browsers).map(([name, minimum]) => `${name} >= ${minimum}`),
  ),
  buildTargets: Object.freeze(
    Object.entries(browsers).map(([name, minimum]) => name.toLowerCase() + minimum),
  ),
});
