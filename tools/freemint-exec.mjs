// 免费铸造执行器：只铸「零价」的部分，一旦要花钱就停
// 用法: node tools/freemint-exec.mjs --token 0x... [--token 0x...] [--max 5] [--dry]
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { keccak256 } from "js-sha3";

const args = process.argv.slice(2);
const tokens = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--token") tokens.push(args[i + 1]);
const MAX = Number(args.includes("--max") ? args[args.indexOf("--max") + 1] : "5");
const DRY = args.includes("--dry");
const WALLET = "0x18D71d34267697FEDf23210a87A7959e42C98792";
const RPC = "https://bsc-dataseed.binance.org";
const BAW_ENV = { ...process.env, HTTPS_PROXY: "http://127.0.0.1:12450", HTTP_PROXY: "http://127.0.0.1:12450", NODE_USE_ENV_PROXY: "1" };
const tg = JSON.parse(fs.readFileSync(".dsh/tg-main.json", "utf8"));

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
async function notify(text) {
  if (DRY) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {}
}
async function rpc(method, params) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.error) return null;
      return j.result;
    } catch { await new Promise((r) => setTimeout(r, 700)); }
  }
  return null;
}
const int = (h) => (h && h !== "0x" ? parseInt(h, 16) : null);
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
function bawJson(a, timeout = 120000) {
  const r = spawnSync("baw", a, { encoding: "utf8", env: BAW_ENV, timeout, shell: true });
  const out = (r.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) throw new Error((out || r.stderr || "no output").slice(0, 100));
  return JSON.parse(out.slice(i));
}

// 候选 mint 调用（按常见程度排序）
const W = WALLET.slice(2).toLowerCase();
const pad = (hex) => "0".repeat(64 - hex.length) + hex;
const SELECTORS = [
  { name: "mint(1)", data: "0xa0712d68" + pad("1") },
  { name: "mint()", data: "0x1249c58b" },
  { name: "mint(2)", data: "0xa0712d68" + pad("2") },
  { name: "claim()", data: "0x4e71d92d" },
  { name: "publicMint()", data: "0x26092b83" },
  { name: "freeMint()", data: "0x5b70ea9f" },
  { name: "mint(addr,1)", data: "0x40c10f19" + pad(W) + pad("1") },
  { name: "safeMint(addr)", data: "0x40d097c3" + pad(W) },
  { name: "mintTo(addr)", data: "0x755edd17" + pad(W) },
];

async function balanceOf(addr) {
  return int(await call(addr, "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase())) ?? 0;
}

async function execMint(addr, data) {
  const prev = bawJson(["contract-call", "preview", "--binanceChainId", "56", "--from", WALLET, "--to", addr, "--value", "0", "--inputData", data, "--json"]);
  if (!prev.success) return { ok: false, reason: JSON.stringify(prev.error || {}).slice(0, 100) };
  const sim = prev.data?.simulationResult?.simulationCode;
  if (sim && sim !== "000000000") return { ok: false, reason: `模拟 ${sim}` };
  if (DRY) return { ok: true, dry: true };
  const ex = bawJson(["contract-call", "execute", "--requestId", prev.data.requestId, "--json"], 150000);
  return ex.success ? { ok: true, txHash: ex.data?.txHash } : { ok: false, reason: JSON.stringify(ex.error || {}).slice(0, 100) };
}

for (const token of tokens) {
  const is721 = int(await call(token, "0x01ffc9a780ac58cd" + "0".repeat(56))) === 1;
  const total = int(await call(token, "0x18160ddd"));
  const maxSup = int(await call(token, "0xd5abeb01"));
  let bal = await balanceOf(token);
  log(`== ${token} ERC721=${is721} total=${total} max=${maxSup} 已持有=${bal}`);
  if (!is721) { await notify(`⚠️ ${token} 不是 ERC721，跳过`); continue; }

  let minted = 0;
  for (let round = 1; round <= MAX; round++) {
    let done = false;
    for (const sel of SELECTORS) {
      const before = await balanceOf(token);
      const r = await execMint(token, sel.data);
      if (!r.ok) { log(`  ${sel.name} 失败：${r.reason}`); continue; }
      if (r.dry) { log(`  ${sel.name} 模拟可铸（DRY）`); done = true; break; }
      await new Promise((res) => setTimeout(res, 6000));
      const after = await balanceOf(token);
      if (after > before) {
        minted += after - before;
        log(`  ✅ ${sel.name} 成功 +${after - before}，tx ${r.txHash}`);
        done = true;
        break;
      }
      log(`  ${sel.name} 已发但余额没变（可能 revert），tx ${r.txHash}`);
      continue;
    }
    if (!done) { log("  无更多免费份额，停止"); break; }
  }
  const finalBal = await balanceOf(token);
  if (minted > 0 || finalBal > bal) {
    await notify(`✅ 免费铸造完成\n${token}\n本次铸得 ${finalBal - bal} 张（累计持有 ${finalBal}）\n总供应 ${total}/${maxSup ?? "?"}`);
  } else {
    await notify(`ℹ️ ${token} 没有铸到（免费份额可能已满或用完）\n总供应 ${total}/${maxSup ?? "?"}`);
  }
}
