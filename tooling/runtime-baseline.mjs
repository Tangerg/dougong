const browsers = { Chrome: "119", Edge: "119", Firefox: "124", Safari: "17.4" };
// These releases give native-state AbortSignal composition collectible dependency graphs.
const nodeLongTermSupportMinimum = "24.22.0";
const nodeCurrentMinimum = "26.10.0";

export const runtimeBaseline = Object.freeze({
  engines: Object.freeze({
    node: `^${nodeLongTermSupportMinimum} || >=${nodeCurrentMinimum}`,
  }),
  nodeTestVersions: Object.freeze(
    [nodeLongTermSupportMinimum, nodeCurrentMinimum].flatMap((version) => [
      version,
      version.split(".")[0],
    ]),
  ),
  browserslist: Object.freeze(
    Object.entries(browsers).map(([name, minimum]) => `${name} >= ${minimum}`),
  ),
  buildTargets: Object.freeze(
    Object.entries(browsers).map(([name, minimum]) => name.toLowerCase() + minimum),
  ),
});
