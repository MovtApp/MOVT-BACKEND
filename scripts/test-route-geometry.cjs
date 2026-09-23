const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function matching(responseFor) {
  const context = { module: { exports: {} }, process: { env: { MAPBOX_TOKEN: "test-only" } },
    require: (name) => {
      if (name !== "axios") throw new Error(name);
      return { get: async (url) => {
        const coords = url.split("/").at(-1).split(";").map((p) => p.split(",").map(Number));
        return { data: responseFor(coords) };
      } };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/mapMatchingService.js"), "utf8"), context);
  return context.module.exports;
}
function response(coords) {
  return { code: "Ok", matchings: [{ confidence: 0.95, geometry: { coordinates: coords } }],
    tracepoints: coords.map(() => ({ matchings_index: 0 })) };
}
const route = (n) => Array.from({ length: n }, (_, i) => ({
  latitude: -23.565, longitude: -46.626 + i * 0.00003,
  accuracy: 5, timestamp: 1800000000000 + i * 5000,
}));

test("unmatched interior points remain GPS instead of disappearing", async () => {
  const service = matching((coords) => {
    const data = response(coords); data.tracepoints[1] = null; return data;
  });
  const input = route(5);
  const result = await service.snapRoute(input, "Corrida");
  assert.equal(result.confidence, 0);
  assert.equal(result.snapped.length, input.length);
});

test("long routes join windows without walking backwards over overlap", async () => {
  const service = matching(response);
  const result = await service.snapRoute(route(210), "Corrida");
  assert.equal(result.snapped.length, 210);
  for (let i = 1; i < result.snapped.length; i++) {
    assert.ok(result.snapped[i].longitude > result.snapped[i - 1].longitude);
  }
});

test("a confident detour with correct endpoints is still rejected", async () => {
  const service = matching((coords) => {
    const data = response(coords);
    data.matchings[0].geometry.coordinates = [coords[0], [coords[1][0], coords[1][1] + 0.003], coords.at(-1)];
    return data;
  });
  const result = await service.snapRoute(route(8), "Corrida");
  assert.equal(result.confidence, 0);
  assert.equal(result.snapped.length, 8);
});

test("explicit interruptions survive matching", async () => {
  const input = route(8); input[4].gap = true;
  const result = await matching(response).snapRoute(input, "Corrida");
  assert.equal(result.snapped.filter((p) => p.gap).length, 1);
  assert.equal(result.snapped[4].gap, true);
});

test("share card renders separate paths on opposite sides of a gap", () => {
  const source = fs.readFileSync(path.join(__dirname, "../services/shareCardService.js"), "utf8");
  const context = { module: { exports: {} }, process: { env: {} }, __dirname,
    require: (name) => {
      if (name === "path") return path;
      if (name === "os") return require("node:os");
      if (name === "fs") return fs;
      if (name === "@resvg/resvg-js") return {};
      if (name === "./oswaldFontBase64" || name === "./logoBase64") return "";
      if (name === "axios" || name === "sharp") return {};
      throw new Error(name);
    },
  };
  vm.runInNewContext(source + "\nmodule.exports.testUrl = buildMapUrl;", context);
  const input = route(5); input[3].gap = true;
  const url = context.module.exports.testUrl(input, "10b981", 100, 100);
  assert.equal((url.match(/path-6/g) ?? []).length, 2);
});
