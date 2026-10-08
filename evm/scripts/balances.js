const { TOKENS, USDG } = require("./robinhood");
const RPC = process.env.RPC || "https://rpc.testnet.chain.robinhood.com";
const who = process.argv[2];
const call = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
(async () => {
  console.log("ETH ", Number(BigInt(await call("eth_getBalance", [who, "latest"]))) / 1e18);
  for (const [s, t] of [...Object.entries(TOKENS).map(([k, v]) => [k, v.address]), ["USDG", USDG]]) {
    const r = await call("eth_call", [{ to: t, data: "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
    console.log(s.padEnd(5), Number(BigInt(r)) / (s === "USDG" ? 1e6 : 1e18));
  }
})();
