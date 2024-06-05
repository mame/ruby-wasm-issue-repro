import { RubyVM, consolePrinter } from "./node_modules/@ruby/wasm-wasi/dist/esm/index.js";
import { WASI, File, OpenFile, PreopenDirectory } from "./node_modules/@bjorn3/browser_wasi_shim/dist/index.js";
import fs from "fs";

const setupRubyWasm = async (image) => {
  const module = await WebAssembly.compile(image);
  const fds = [
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new PreopenDirectory("/", []),
  ];
  const wasi = new WASI([], [], fds, { debug: false });
  const vm = new RubyVM();

  const imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
  };
  vm.addToImports(imports);

  const printer = consolePrinter();
  printer.addToImports(imports);
  const instance = await WebAssembly.instantiate(module, imports);
  await vm.setInstance(instance);

  printer.setMemory(instance.exports.memory);

  wasi.initialize(instance);
  vm.initialize();

  return vm;
}

const main = async () => {
  const image = fs.readFileSync("./node_modules/@ruby/head-wasm-wasi/dist/ruby+stdlib.wasm");
  const vm = await setupRubyWasm(image);

  vm.eval("-> js_funcs { JSFuncs = js_funcs }").call("call", vm.wrap({
    foo: async () => {
        return "foo";
    },
  }));
  
  vm.evalAsync(`
    #TracePoint.new {|tp| p tp }.enable
    GC.stress = true
    JSFuncs[:foo].apply().await
  `);
};

main();

// How to reproduce the bug:
//
// $ node repro.mjs 
// Tried to report internal Ruby VM state but failed:  RuntimeError: null function or function signature mismatch
// ...
