// Types ctx.exports, the loopback bindings to main.ts's exports
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./main.ts");
  }
}
