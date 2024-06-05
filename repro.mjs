import { RubyVM, consolePrinter } from "./node_modules/@ruby/wasm-wasi/dist/esm/index.js";
import { WASI, File, OpenFile, PreopenDirectory } from "./node_modules/@bjorn3/browser_wasi_shim/dist/index.js";
import fs from "fs";

const fd = fs.openSync("/dev/stdin", "rs");

const setupRubyWasm = async (image, out) => {
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

  const printer = consolePrinter({ stdout: out, stderr: out });
  printer.addToImports(imports);
  const instance = await WebAssembly.instantiate(module, imports);
  await vm.setInstance(instance);

  printer.setMemory(instance.exports.memory);

  wasi.initialize(instance);
  vm.initialize();

  return vm;
}

const buffer = [];
const waiters = [];
process.stdin.on("readable", () => {
    let chunk;
    while (chunk = process.stdin.read()) {
        for (let i = 0; i < chunk.length; i++) {
            buffer.push(chunk[i]);
        }
    }
    if (buffer.length >= 1) {
        for (let i = 0; i < waiters.length; i++) {
            waiters[i]();
        }
        waiters.length = 0;
    }
});

const main = async () => {
  const image = fs.readFileSync("./node_modules/@ruby/head-wasm-wasi/dist/ruby.debug+stdlib.wasm");
  const vm = await setupRubyWasm(image, (data) => process.stdout.write(data));

  vm.eval("-> js_funcs { JSFuncs = js_funcs }").call("call", vm.wrap({
    getByte: async () => {
        const buffer = Buffer.alloc(1);
        fs.readSync(fd, buffer, 0, 1, null);
        return buffer[0];
    },
  }));
  
  vm.evalAsync(`
  require "js"

  # Hack to ignore "require 'io/console'" and "require 'io/wait'"
  Dir.mkdir("/tmp")
  Dir.mkdir("/tmp/io")
  File.write("/tmp/io/console.rb", "")
  File.write("/tmp/io/wait.rb", "")
  $LOAD_PATH.unshift("/tmp")
  module Kernel
    alias_method :require, :gem_original_require
  end
  
  # io shim
  class IO
    alias getbyte_orig getbyte
    def getbyte
      if to_i == 0
        c = JSFuncs[:getByte].apply().await
        return c == JS::Null ? nil : c.to_i
      end
      getbyte_orig
    end
  
    alias getc_orig getc
    def getc
      return getbyte&.chr if to_i == 0
      getc_orig
    end
  
    def gets
      s = ""
      while c = getc
        s << c
        break if c == "\n"
      end
      s
    end
  
    def tty?
      false
    end
  end
  
  require "irb"
  
  # Hack to avoid IO.open(1, "w")
  module IRB
    class StdioInputMethod < InputMethod
      def initialize
        @line_no = 0
        @line = []
        @stdin = IO.open(STDIN.to_i, :external_encoding => IRB.conf[:LC_MESSAGES].encoding, :internal_encoding => "-")
        # original: @stdout = IO.open(STDOUT.to_i, 'w', :external_encoding => IRB.conf[:LC_MESSAGES].encoding, :internal_encoding => "-")
        @stdout = STDOUT
      end
    end
  end
  
  # Run irb
  IRB.setup(nil, argv: ['--no-pager'])
  GC.stress = true
  IRB::Irb.new.run
    `);
};

main();

// How to reproduce the bug:
//
// $ node repro.mjs 
// Tried to report internal Ruby VM state but failed:  RuntimeError: null function or function signature mismatch
// ...
